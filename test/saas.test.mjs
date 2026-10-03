import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import pg from 'pg';
import Stripe from 'stripe';
import express from 'express';
import vm from 'node:vm';
import { z } from 'zod';
import { AccessError } from '../src/saas/service.mjs';
import { registerSaasRoutes, createAccessGate } from '../src/saas/routes.mjs';
import { createSaasService, effectiveEntitlement, assertCapability, quantityOf } from '../src/saas/service.mjs';
import { verifyBillingEvent, applySubscriptionEvent } from '../src/saas/billing.mjs';
import {notifySaas} from '../src/saas/notifications.mjs';

const plans=[{id:'free',name:'Free',monthly_generation_quota:0,capabilities:{}},{id:'pro',name:'YSong Pro',monthly_generation_quota:20,capabilities:{generation:true}}];
const base={role:'user',account_status:'active',plan_id:'pro',subscription_status:'active',period_end:'2099-01-01',override_quota:null};
test('entitlement resolution expires subscriptions and overrides without trusting frontend plan',()=>{
  assert.equal(effectiveEntitlement(base,plans).planId,'pro');
  assert.equal(effectiveEntitlement({...base,subscription_status:'past_due'},plans).planId,'free');
  assert.equal(effectiveEntitlement({...base,override_plan_id:'free',override_expires_at:'2000-01-01'},plans).planId,'pro');
  const comp=effectiveEntitlement({...base,subscription_status:'none',override_plan_id:'pro',override_quota:42},plans);
  assert.equal(comp.quota,42);
  assert.throws(()=>assertCapability(effectiveEntitlement({...base,subscription_status:'none'},plans),'generation'),/plan_restricted/);
});
test('superadmin has all capabilities with no quota charging; account restrictions are explicit',()=>{
  const e=effectiveEntitlement({...base,role:'superadmin',subscription_status:'none'},plans);
  assert.equal(e.quota,null); assertCapability(e,'generation'); assertCapability(e,'uploads');
  for(const status of ['banned','suspended']) assert.throws(()=>assertCapability({...e,status},'generation'),new RegExp(status));
  assert.throws(()=>assertCapability({...e,generationDisabled:true},'generation'),/generation_disabled/);
  for(const quantity of [0,21,1.5,'20',null]) assert.throws(()=>quantityOf(quantity),/invalid_quantity/);
  assert.equal(quantityOf(20),20);
});
test('official webhook signature rejects tampering, stale signatures and test/live mismatch',()=>{
  const payload=JSON.stringify({id:'evt_test',type:'customer.subscription.updated',livemode:false,created:1});
  const secret='whsec_test_only'; const env={STRIPE_WEBHOOK_SECRET:secret,BILLING_MODE:'test'};
  const signature=Stripe.webhooks.generateTestHeaderString({payload,secret});
  assert.equal(verifyBillingEvent(Buffer.from(payload),signature,env).id,'evt_test');
  assert.throws(()=>verifyBillingEvent(Buffer.from(payload+' '),signature,env),/invalid_webhook_signature/);
  assert.throws(()=>verifyBillingEvent(Buffer.from(payload),signature,{...env,BILLING_MODE:'live'}),/billing_mode_mismatch/);
  const old=Stripe.webhooks.generateTestHeaderString({payload,secret,timestamp:1});
  assert.throws(()=>verifyBillingEvent(Buffer.from(payload),old,env),/invalid_webhook_signature/);
});

test('isolated PostgreSQL: additive migration, concurrency, quota lifecycle, lineage, admin and billing transactions',
 {skip:!process.env.TEST_SAAS_DATABASE_URL},async t=>{
  const url=new URL(process.env.TEST_SAAS_DATABASE_URL);
  if(!['localhost','127.0.0.1'].includes(url.hostname) || url.pathname!=='/ysong_saas_validation') throw new Error('SaaS integration tests require the dedicated loopback validation database.');
  const schema=`saas_test_${crypto.randomUUID().replaceAll('-','')}`;
  const root=new pg.Pool({connectionString:url.href});
  await root.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({connectionString:url.href,options:`-c search_path=${schema}`,max:10});
  t.after(async()=>{await pool.end();await root.end();}); // Preserve fixture schema for review, never drop data.
  await pool.query('CREATE TABLE users(id uuid PRIMARY KEY,email text,display_name text,created_at timestamptz DEFAULT now())');
  const admin=crypto.randomUUID(),user=crypto.randomUUID(),other=crypto.randomUUID();
  await pool.query('INSERT INTO users(id,email) VALUES($1,$2),($3,$4),($5,$6)',[admin,'psychopathetica@gmail.com',user,'fixture@example.invalid',other,'other@example.invalid']);
  const sql=await fs.readFile(new URL('../src/saas/schema.sql',import.meta.url),'utf8');
  await pool.query(sql); await pool.query(sql);
  await pool.query("UPDATE ysong_plans SET monthly_generation_quota=20,capabilities='{\"generation\":true,\"assistant\":true,\"uploads\":true}' WHERE id='pro'");
  await pool.query("UPDATE ysong_plans SET monthly_generation_quota=0 WHERE id='free'");
  await pool.query("UPDATE ysong_account_access SET plan_id='pro',subscription_status='active',period_end='2099-01-01' WHERE user_id=$1",[user]);
  const service=createSaasService(pool);
  await t.test('stored immutable admin identity bypasses quotas even after email changes',async()=>{
    await pool.query('UPDATE users SET email=$2 WHERE id=$1',[admin,'changed@example.invalid']);
    await pool.query('UPDATE users SET email=$2 WHERE id=$1',[other,'psychopathetica@gmail.com']);
    await pool.query(sql);
    assert.equal((await service.access(admin)).superadmin,true);
    assert.equal((await service.account(pool,other)).role,'user');
    const batch=await service.reserve(admin,{requestKey:'admin-first',quantity:20,source:{prompt:'test'}});
    assert.equal(batch.versions.length,20); assert.equal(batch.batch.charged,false);
    assert.equal((await pool.query('SELECT * FROM ysong_quota_periods WHERE user_id=$1',[admin])).rows.length,0);
  });
  await t.test('concurrent reservations cannot spend beyond twenty units',async()=>{
    const outcomes=await Promise.allSettled(Array.from({length:25},(_,i)=>service.reserve(user,{requestKey:`concurrent-${i}`,quantity:1,source:{prompt:`version ${i}`}})));
    assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,20);
    assert.equal(outcomes.filter(r=>r.status==='rejected'&&r.reason.code==='quota_exhausted').length,5);
    assert.equal((await service.summary(user)).reserved,20);
  });
  const first=(await pool.query('SELECT * FROM ysong_generation_versions WHERE user_id=$1 ORDER BY created_at LIMIT 1',[user])).rows[0];
  await t.test('failure refunds once; successful/disliked work remains consumed',async()=>{
    await Promise.all([service.reconcile(first.id,'failed'),service.reconcile(first.id,'failed')]);
    assert.equal((await service.summary(user)).reserved,19);
    const next=await service.reserve(user,{requestKey:'after-failure',source:{prompt:'valid'}});
    await service.start(next.versions[0].id,'cloudflare','minimax/music-2.6');
    await service.reconcile(next.versions[0].id,'ready',{objectKey:'fixture.wav'});
    await service.reconcile(next.versions[0].id,'failed');
    await pool.query('UPDATE ysong_generation_versions SET feedback=-1 WHERE id=$1',[next.versions[0].id]);
    assert.equal((await service.summary(user)).used,1);
    assert.equal((await service.summary(user)).reserved,19);
  });
  await t.test('batch quantity, unique projects, idempotency conflict and persistent lineage',async()=>{
    await service.adminAction(admin,other,'override',{planId:'pro',quota:20},'Test comp access');
    const input={requestKey:'twenty-versions',quantity:20,source:{prompt:'exact prompt',lyrics:'exact lyrics',plan:'premium',remaining:9999}};
    const b=await service.reserve(other,input);
    assert.equal(b.versions.length,20);assert.equal(new Set(b.versions.map(v=>v.project_id)).size,20);
    const replay=await service.reserve(other,input);assert.equal(replay.batch.id,b.batch.id);assert.equal(replay.replay,true);
    await assert.rejects(service.reserve(other,{...input,quantity:1}),/idempotency_conflict/);
    await assert.rejects(service.reserve(other,{...input,requestKey:'spoof-quota',quantity:1}),/quota_exhausted/);
    const db=(await pool.query('SELECT source FROM ysong_generation_batches WHERE id=$1',[b.batch.id])).rows[0];
    assert.equal(db.source.lyrics,'exact lyrics');
    await service.reconcile(b.versions[0].id,'failed');
    const child=await service.reserve(other,{requestKey:'variation-1',source:{prompt:'variation'},parentId:b.versions[0].id});
    assert.equal(child.batch.parent_generation_id,b.versions[0].id);
    assert.notEqual(child.versions[0].project_id,b.versions[0].project_id);
    await assert.rejects(service.reserve(user,{requestKey:'foreign-parent',source:{prompt:'test'},parentId:b.versions[0].id}),/parent_not_found/);
  });
  await t.test('bans, upload restrictions, revocation and audited reversible admin operations',async()=>{
    await service.adminAction(admin,other,'ban',null,'Verified abuse');
    await assert.rejects(service.access(other),/account_banned/);
    await assert.rejects(service.reserve(other,{requestKey:'blocked-ban',source:{prompt:'test'}}),/account_banned/);
    await service.adminAction(admin,other,'unban',null,'Review reversed');
    await service.adminAction(admin,other,'uploads',true,'Pause upload rights');
    const awaitAccess=await service.access(other);
    assert.throws(()=>assertCapability(awaitAccess,'uploads'),/uploads_disabled/);
    await service.adminAction(admin,other,'revoke_sessions',null,'Owner requested logout');
    await assert.rejects(service.access(other,1),/session_revoked/);
    await assert.rejects(service.adminAction(user,other,'ban',null,'Unauthorized action'),/admin_required/);
    await assert.rejects(service.adminAction(admin,admin,'ban',null,'Accidental self ban'),/protected_account/);
    assert.ok((await pool.query('SELECT * FROM ysong_admin_audit WHERE target_id=$1',[other])).rows.length>=4);
  });
  await t.test('billing replay/stale events are safe and comp/role survive billing updates',async()=>{
    await pool.query("UPDATE ysong_plans SET billing_prices='{\"stripe:test\":\"price_fixture\"}' WHERE id='pro'");
    await pool.query("UPDATE ysong_account_access SET billing_provider='stripe',billing_live=false,billing_customer_id='cus_fixture' WHERE user_id=$1",[other]);
    const subscription={id:'sub_fixture',customer:'cus_fixture',livemode:false,status:'active',items:{data:[{price:{id:'price_fixture',product:'prod_fixture'},current_period_start:100,current_period_end:4102444800}]}};
    const event={id:'evt_fixture',type:'customer.subscription.updated',created:200,livemode:false};
    assert.equal((await applySubscriptionEvent(service,event,subscription)).applied,true);
    assert.equal((await applySubscriptionEvent(service,event,subscription)).duplicate,true);
    assert.equal((await applySubscriptionEvent(service,{...event,id:'evt_old',created:100},subscription)).stale,true);
    const a=await service.account(pool,other); assert.equal(a.override_plan_id,'pro'); assert.equal(a.override_quota,20);
    assert.equal((await service.account(pool,admin)).role,'superadmin');
    await assert.rejects(applySubscriptionEvent(service,{...event,id:'evt_unknown',created:300},{...subscription,items:{data:[{price:{id:'price_unknown'}}]}}),/billing_price_not_configured/);
    assert.equal((await pool.query("SELECT * FROM ysong_billing_events WHERE event_id='evt_unknown'")).rows.length,0);
  });
  await t.test('HTTP boundaries authenticate, reject spoofing and cross-owner history edits, and meter actual provider outcomes',async()=>{
    const owner=crypto.randomUUID();await pool.query('INSERT INTO users(id,email) VALUES($1,$2)',[owner,'http@example.invalid']);
    await service.adminAction(admin,owner,'override',{planId:'pro',quota:2},'HTTP fixture access');
    const app=express();app.use(express.json());
    const requireAuth=async(req,res,next)=>{const id=req.get('authorization');if(![owner,admin].includes(id))return res.status(401).end();try{await service.access(id);req.user={id};next();}catch(e){res.status(e.status||503).json({error:e.code});}};
    const enabled=()=>true;
    app.use(createAccessGate({service,requireAuth,enabled}));
    registerSaasRoutes(app,{pool,service,requireAuth,enabled,env:{BILLING_MODE:'test'}});
    let calls=0,fail=false;
    const provider=async()=>{calls++;if(fail)throw new Error('fixture failure');return{audio:Buffer.from('real-audio-fixture'),contentType:'audio/wav',provider:'cloudflare'};};
    const source=await fs.readFile(new URL('../src/index.js',import.meta.url),'utf8');
    const start=source.indexOf('app.post(\n\t"/api/music/generate"');const end=source.indexOf('// Optional AI bridge',start);
    vm.runInNewContext(source.slice(start,end),{app,LOCAL_MODE:false,requireAuth,saasEnabled:enabled,saas:service,AccessError,crypto,Buffer,notifySaas,
      MusicGenerateSchema:z.object({instructions:z.string(),lyrics:z.string().optional()}),miniMaxProvider:()=> 'cloudflare',cloudflareMusicConfig:()=>({model:'minimax/music-2.6'}),
      generateWithCloudflareMusic:provider,persistGenerationAudio:async(uid,id)=>`user-uploads/${uid}/generations/${id}.wav`,sha256:v=>crypto.createHash('sha256').update(v).digest('hex'),console:{error(){}}});
    const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    try{
      const base=`http://127.0.0.1:${server.address().port}`;
      const post=(path,body,key='test-key-1',id=owner)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',authorization:id,'idempotency-key':key},body:JSON.stringify(body)});
      assert.equal((await post('/api/music/generate',{instructions:'test'},'no-auth-1','')).status,401);assert.equal(calls,0);
      assert.equal((await post('/api/music/generate',{instructions:'test',quantity:20},'wrong-batch')).status,400);assert.equal(calls,0);
      fail=true;assert.equal((await post('/api/music/generate',{instructions:'test'},'failure-1')).status,502);
      assert.equal((await service.summary(owner)).reserved,1);assert.equal((await service.summary(owner)).used,0);
      const uncertain=(await pool.query("SELECT * FROM ysong_generation_versions WHERE user_id=$1 AND error_code='provider_outcome_uncertain'",[owner])).rows[0];assert.equal(uncertain.execution.parts.audio.state,'ambiguous');
      fail=false;const ok=await post('/api/music/generate',{instructions:'test',plan:'premium',remaining:99999},'success-1');
      assert.equal(ok.status,200);assert.equal(await ok.text(),'real-audio-fixture');
      const version=ok.headers.get('x-ysong-generation-id');assert.ok(version);
      const count=calls;assert.equal((await post('/api/music/generate',{instructions:'test',plan:'premium',remaining:99999},'success-1')).status,409);assert.equal(calls,count);
      assert.equal((await service.summary(owner)).used,1);
      assert.equal((await post(`/api/generations/${version}/feedback`,{feedback:-1})).status,200);
      assert.equal((await post(`/api/generations/${version}/feedback`,{feedback:1},'foreign-1',admin)).status,404);
      assert.equal((await post(`/api/generations/${version}/cancel`,{})).status,409);
      assert.equal((await service.summary(owner)).used,1);
      const history=await(await fetch(base+'/api/generations/history',{headers:{authorization:owner}})).json();assert.ok(history.generations.some(v=>v.id===version&&v.project_id));
      await service.adminAction(admin,owner,'suspend',null,'Security test');
      assert.equal((await post('/api/music/generate',{instructions:'test'},'suspended-1')).status,403);assert.equal(calls,count);
    }finally{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
  });
});
