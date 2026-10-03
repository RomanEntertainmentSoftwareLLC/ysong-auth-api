import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import pg from 'pg';
import express from 'express';
import Stripe from 'stripe';
import {createSaasService} from '../src/saas/service.mjs';
import {registerSaasRoutes,createAccessGate} from '../src/saas/routes.mjs';
import {registerRecoveryRoutes} from '../src/saas/recovery.mjs';
import {registerBillingWebhook} from '../src/saas/billing.mjs';
import {createSessionJobs,sessionSource} from '../src/saas/jobs.mjs';

test('Priority 1 admin and recovery HTTP regression on isolated PostgreSQL',async t=>{
  assert.ok(process.env.TEST_SAAS_DATABASE_URL,'Required validation: set dedicated loopback TEST_SAAS_DATABASE_URL');
  const url=new URL(process.env.TEST_SAAS_DATABASE_URL);
  assert.ok(['localhost','127.0.0.1'].includes(url.hostname)&&url.pathname==='/ysong_saas_validation','Dedicated loopback database required');
  const schema='admin_recovery_'+crypto.randomUUID().replaceAll('-','');
  const root=new pg.Pool({connectionString:url.href});
  await root.query('CREATE SCHEMA '+schema);
  const pool=new pg.Pool({connectionString:url.href,options:'-c search_path='+schema,max:12});
  t.after(async()=>{await pool.end();await root.end();}); // Retain isolated evidence.
  await pool.query("CREATE TABLE users(id uuid PRIMARY KEY,email text,display_name text,created_at timestamptz DEFAULT now()); CREATE TABLE user_client_state(user_id uuid PRIMARY KEY,state jsonb DEFAULT '{}',updated_at timestamptz DEFAULT now())");
  const [superadmin,admin,peer,user]=Array.from({length:4},()=>crypto.randomUUID());
  for(const [id,email] of [[superadmin,'psychopathetica@gmail.com'],[admin,'admin@example.invalid'],[peer,'peer@example.invalid'],[user,'user@example.invalid']])await pool.query('INSERT INTO users(id,email) VALUES($1,$2)',[id,email]);
  const sql=await fs.readFile(new URL('../src/saas/schema.sql',import.meta.url),'utf8');
  await pool.query(sql);
  await pool.query("UPDATE ysong_account_access SET role='admin' WHERE user_id=ANY($1)",[[admin,peer]]);
  await pool.query("UPDATE ysong_plans SET monthly_generation_quota=30,capabilities='{\"generation\":true,\"uploads\":true}',billing_prices='{\"stripe:test\":\"price_pro\"}' WHERE id='pro'");
  const service=createSaasService(pool);
  for(const id of [admin,peer,user])await service.adminAction(superadmin,id,'override',{planId:'pro',quota:30},'Regression fixture access');
  const reason='Verified local regression recovery evidence';
  const env={BILLING_MODE:'test',STRIPE_WEBHOOK_SECRET:'whsec_local_regression',BILLING_WEBHOOK_ENABLED:'1'};
  const subscription=id=>({id:'sub_'+id,customer:'cus_'+id,livemode:false,status:'active',current_period_start:100,current_period_end:4102444800,items:{data:[{price:{id:'price_pro',product:'prod_pro'}}]}});
  let failStripe=false,wrongMode=false,stripeReads=0,providerCalls=0,uploads=0,artifactReads=0,onRetrieve=async()=>{};
  const events=new Map();
  const stripe={subscriptions:{retrieve:async id=>{stripeReads++;await onRetrieve();if(failStripe)throw new Error('Mock Stripe outage');return {...subscription(id.slice(4)),livemode:wrongMode};}},
    customers:{retrieve:async id=>({id,livemode:false,metadata:{ysong_user_id:id.slice(4)}})},
    events:{retrieve:async id=>{stripeReads++;return events.get(id);}}};
  const adapter=()=>({stripe,live:false});
  const app=express();registerBillingWebhook(app,express,service,()=>true,env,adapter);app.use(express.json());
  // Only authentication transport is a fixture; production access/role/quota gates execute.
  const auth=async(req,res,next)=>{
    const id=req.get('authorization');if(![superadmin,admin,peer,user].includes(id))return res.sendStatus(401);
    const issuedAt=Number(req.get('x-fixture-issued-at')??Math.floor(Date.now()/1000));
    try{await service.access(id,issuedAt);req.user={id,issuedAt};next();}catch(e){res.status(e.status??503).json({error:e.code});}
  };
  app.use(createAccessGate({service,requireAuth:auth,enabled:()=>true}));
  registerSaasRoutes(app,{pool,service,requireAuth:auth,enabled:()=>true,env,billingAdapter:adapter});
  registerRecoveryRoutes(app,{pool,service,requireAuth:auth,enabled:()=>true,env,billingAdapter:adapter});
  const jobs=createSessionJobs({pool,service,enabled:()=>true,provider:()=>({provider:'cloudflare',model:'fixture'}),
    generate:async()=>{providerCalls++;throw new Error('Unexpected paid render');},persist:async()=>{throw new Error('Unexpected storage write');},
    inspectArtifact:async()=>{artifactReads++;return {hash:'fixture-hash',bytes:44,contentType:'audio/wav'};}});
  jobs.register(app,auth);
  app.post('/api/music/generate',auth,(req,res)=>{providerCalls++;res.json({ok:true});});
  app.post('/api/uploads',auth,(req,res)=>{uploads++;res.json({ok:true});});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
  const request=async(path,body,id=admin,headers={})=>{
    const r=await fetch('http://127.0.0.1:'+server.address().port+path,{method:body===undefined?'GET':'POST',headers:{authorization:id,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:r.status,data:await r.json().catch(()=>null)};
  };
  const action=(id,action,value,actor=admin)=>request('/api/admin/accounts/'+id+'/actions',{action,value,reason},actor);
  const countAudit=async()=>Number((await pool.query('SELECT count(*) AS n FROM ysong_admin_audit')).rows[0].n);
  const version=async id=>(await pool.query('SELECT * FROM ysong_generation_versions WHERE id=$1',[id])).rows[0];
  const reserve=async(id,key,source={instructions:'fixture'})=>(await service.reserve(id,{requestKey:key,source})).versions[0];
  const signed=async event=>{
    const payload=JSON.stringify(event),signature=Stripe.webhooks.generateTestHeaderString({payload,secret:env.STRIPE_WEBHOOK_SECRET});
    const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/billing/webhook',{method:'POST',headers:{'content-type':'application/json','stripe-signature':signature},body:payload});
    return {status:r.status,data:await r.json()};
  };

  await t.test('immutable superadmin and normal-admin protected targets cannot be changed through HTTP',async()=>{
    await pool.query('UPDATE users SET email=$2 WHERE id=$1',[superadmin,'renamed@example.invalid']);
    await pool.query('UPDATE users SET email=$2 WHERE id=$1',[user,'psychopathetica@gmail.com']);await pool.query(sql);
    assert.equal((await service.account(pool,superadmin)).role,'superadmin');assert.equal((await service.account(pool,user)).role,'user');
    const before=await countAudit();
    for(const target of [superadmin,admin,peer])for(const operation of ['ban','suspend','unban','generation','uploads','revoke_sessions','override','note']){
      const r=await action(target,operation,operation==='override'?{planId:'premium',quota:999}:true);
      assert.equal(r.status,403);assert.equal(r.data.error,'protected_account');
    }
    assert.equal((await action(user,'ban',null,user)).status,403);
    assert.equal((await request('/api/admin/audit',undefined,user)).status,403);
    assert.equal(await countAudit(),before);
    assert.equal((await action(user,'override',{planId:'pro',quota:4})).status,200);
    assert.equal((await service.summary(user,Math.floor(Date.now()/1000))).quota,4);
    assert.equal((await action(user,'override',{planId:'pro',quota:9,expiresAt:'2000-01-01'})).status,200);
    assert.equal((await service.summary(user,Math.floor(Date.now()/1000))).planId,'free');
    assert.equal((await action(user,'override',{planId:'pro',quota:30})).status,200);
    assert.equal((await action(admin,'suspend',null,superadmin)).status,200);
    assert.equal((await action(user,'ban',null)).status,403);
    assert.equal((await action(admin,'unban',null,superadmin)).status,200);
  });
  await t.test('suspension, bans, generation/upload gates and revoked sessions stop execution',async()=>{
    for(const operation of ['suspend','ban']){
      assert.equal((await action(user,operation,null)).status,200);
      for(const path of ['/api/music/generate','/api/uploads'])assert.equal((await request(path,{},user)).status,403);
      assert.equal((await action(user,'unban',null)).status,200);
    }
    for(const [operation,path] of [['generation','/api/music/generate'],['uploads','/api/uploads']]){
      assert.equal((await action(user,operation,true)).status,200);
      assert.equal((await request(path,{},user)).data.error,operation+'_disabled');
      assert.equal((await action(user,operation,false)).status,200);
    }
    assert.equal(providerCalls,0);assert.equal(uploads,0);
    assert.equal((await action(user,'revoke_sessions',null)).status,200);
    assert.equal((await request('/api/uploads',{},user,{'x-fixture-issued-at':'1'})).status,401);
    const revoked=(await service.account(pool,user)).sessions_revoked_before;
    const fresh=String(Math.floor(revoked.getTime()/1000)+1);
    assert.equal((await request('/api/uploads',{},user,{'x-fixture-issued-at':fresh})).status,200);
    assert.equal(uploads,1);
    // Later fixture calls use a newly issued session without a wall-clock sleep.
    await pool.query("UPDATE ysong_account_access SET sessions_revoked_before=now()-interval '2 seconds' WHERE user_id=$1",[user]);
  });
  await t.test('audit failure rolls back the admin mutation and its notification',async()=>{
    const before=await service.account(pool,user),notices=(await pool.query('SELECT count(*) FROM ysong_notifications')).rows;
    await pool.query("CREATE FUNCTION reject_fixture_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture audit outage'; END $$; CREATE TRIGGER reject_audit BEFORE INSERT ON ysong_admin_audit FOR EACH ROW EXECUTE FUNCTION reject_fixture_audit()");
    try{assert.equal((await action(user,'ban',null)).status,503);}finally{await pool.query('DROP TRIGGER reject_audit ON ysong_admin_audit');}
    assert.equal((await service.account(pool,user)).account_status,before.account_status);
    assert.deepEqual((await pool.query('SELECT count(*) FROM ysong_notifications')).rows,notices);
  });
  await t.test('normal admin cannot recover protected generations or recount their quota',async()=>{
    const before=await countAudit();
    for(const owner of [superadmin,peer]){
      const v=await reserve(owner,'protected-'+owner),path='/api/admin/recovery/generations/'+v.id;
      assert.equal((await request(path+'/cancel-queued',{reason})).status,403);
      assert.equal((await version(v.id)).state,'queued');
      await pool.query("UPDATE ysong_generation_versions SET state='generating',execution='{\"parts\":{\"audio\":{\"state\":\"submitted\"}},\"saved\":false}' WHERE id=$1",[v.id]);
      assert.equal((await request(path+'/review-submission',{reason})).status,403);
      await pool.query("UPDATE ysong_generation_versions SET state='failed',execution='{\"parts\":{\"audio\":{\"state\":\"ambiguous\"}},\"saved\":false}' WHERE id=$1",[v.id]);
      assert.equal((await request('/api/admin/generations/'+v.id+'/parts/audio/resolve',{reason,outcome:'confirmed_failure',providerReference:'fixture evidence'})).status,403);
      const batch=(await pool.query('SELECT * FROM ysong_generation_batches WHERE id=$1',[v.batch_id])).rows[0];
      if(batch.charged)assert.equal((await request('/api/admin/recovery/quota/'+batch.quota_period_id+'/recount-reservations',{reason,expectedReserved:1})).status,403);
      assert.equal((await version(v.id)).reconciliation,'reserved');
      const source=sessionSource({plan:{projectName:'Protected recovery',bpm:120,totalBars:1,sigNum:4,sigDen:4,tracks:[{id:'voice',name:'Voice',mode:'audio',renderInstructions:'fixture'}]},prompt:'fixture',lyrics:'fixture'});
      const project=await reserve(owner,'protected-project-'+owner,source);
      await pool.query("UPDATE ysong_generation_versions SET state='failed',execution=$2 WHERE id=$1",[project.id,{parts:{voice:{state:'ready',objectKey:`user-uploads/${owner}/generations/Generation-${project.id}-voice.wav`}},saved:false}]);
      assert.equal((await request('/api/admin/recovery/generations/'+project.id+'/finalize',{reason})).status,403);
      assert.equal((await version(project.id)).state,'failed');
    }
    assert.equal(await countAudit(),before);
  });
  await t.test('uncertain standalone recovery requires evidence, retains reservations and settles exactly once',async()=>{
    for(const success of [false,true]){
      const v=await reserve(user,'uncertain-'+success),path='/api/admin/recovery/generations/'+v.id;
      await service.start(v.id,'cloudflare','fixture');
      await pool.query("UPDATE ysong_generation_versions SET execution='{\"parts\":{\"audio\":{\"state\":\"submitted\"}},\"saved\":false}' WHERE id=$1",[v.id]);
      const release=await service.acquireRender(v.id);
      try{assert.equal((await request(path+'/review-submission',{reason})).status,409);}finally{await release();}
      const before=await service.summary(user,Math.floor(Date.now()/1000));
      assert.equal((await request(path+'/review-submission',{reason})).status,200);
      assert.equal((await request(path+'/cancel-queued',{reason})).status,409);
      assert.equal((await service.summary(user,Math.floor(Date.now()/1000))).reserved,before.reserved);
      const resolve='/api/admin/generations/'+v.id+'/parts/audio/resolve';
      const body={reason,outcome:success?'confirmed_success':'confirmed_failure'};
      assert.equal((await request(resolve,body)).status,400);
      if(success){body.objectKey=`user-uploads/${peer}/generations/Generation-${v.id}.wav`;assert.equal((await request(resolve,body)).status,400);body.objectKey=`user-uploads/${user}/generations/Generation-${v.id}.wav`;}
      else body.providerReference='fixture-confirmed-no-output';
      const results=await Promise.all(Array.from({length:3},()=>request(resolve,body)));
      // Executor advisory locks may reject a competing operator; safe retries converge.
      assert.ok(results.some(r=>r.status===200));assert.ok(results.every(r=>[200,409].includes(r.status)));
      assert.equal((await request(resolve,body)).data.duplicate,true);
      assert.equal((await request(resolve,{...body,outcome:success?'confirmed_failure':'confirmed_success',providerReference:'conflicting-evidence'})).status,409);
      const after=await service.summary(user,Math.floor(Date.now()/1000));assert.equal(after.reserved,before.reserved-1);assert.equal(after.used,before.used+(success?1:0));
      assert.equal((await pool.query("SELECT count(*) AS n FROM ysong_admin_audit WHERE action='render_reconciliation' AND before_state->>'generationId'=$1",[v.id])).rows[0].n,'1');
    }
    assert.equal(artifactReads,1);assert.equal(providerCalls,0);
  });
  await t.test('concurrent quota reservation, consume/refund and recount preserve the ledger',async()=>{
    const before=await service.summary(user,Math.floor(Date.now()/1000));
    await action(user,'override',{planId:'pro',quota:before.used+3});
    const results=await Promise.allSettled(Array.from({length:8},(_,i)=>reserve(user,'quota-race-'+i)));
    const versions=results.filter(r=>r.status==='fulfilled').map(r=>r.value);
    assert.equal(versions.length,3);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.code==='quota_exhausted').length,5);
    await Promise.all(versions.flatMap((v,i)=>[service.reconcile(v.id,i?'failed':'ready'),service.reconcile(v.id,i?'failed':'ready')]));
    const period=(await pool.query('SELECT * FROM ysong_quota_periods WHERE user_id=$1',[user])).rows[0];
    assert.equal(period.reserved,0);assert.equal(period.used,before.used+1);
    await pool.query('UPDATE ysong_quota_periods SET reserved=2 WHERE id=$1',[period.id]);
    const path='/api/admin/recovery/quota/'+period.id+'/recount-reservations';
    assert.equal((await request(path,{reason,expectedReserved:1})).status,409);
    assert.equal((await request(path,{reason,expectedReserved:2})).data.reserved,0);
    assert.equal((await request(path,{reason,expectedReserved:2})).data.duplicate,true);
    assert.equal((await service.summary(user,Math.floor(Date.now()/1000))).used,period.used);
    await action(user,'override',{planId:'pro',quota:30});
  });
  await t.test('project finalization consumes retained artifacts without another provider call',async()=>{
    const source=sessionSource({plan:{projectName:'Recovery',bpm:120,totalBars:1,sigNum:4,sigDen:4,tracks:[{id:'voice',name:'Voice',mode:'audio',renderInstructions:'fixture'}]},prompt:'fixture',lyrics:'fixture'});
    const v=await reserve(user,'project-finalization',source),key=`user-uploads/${user}/generations/Generation-${v.id}-voice.wav`;
    await pool.query("UPDATE ysong_generation_versions SET state='failed',execution=$2 WHERE id=$1",[v.id,{parts:{voice:{state:'ready',objectKey:key}},saved:false}]);
    assert.equal((await request('/api/admin/recovery/generations/'+v.id+'/finalize',{reason},user)).status,403);
    assert.equal((await request('/api/admin/recovery/generations/'+v.id+'/finalize',{reason})).status,200);
    // Do not execute the protected standalone fixtures; the worker selects session sources only.
    await jobs.tick();const done=await version(v.id);
    assert.equal(done.state,'ready');assert.equal(done.reconciliation,'consumed');assert.equal(done.execution.saved,true);
    const project=await request('/api/generations/'+v.id+'/project',undefined,user);
    assert.equal(project.status,200);assert.equal(project.data.projectId,v.project_id);
    assert.equal(providerCalls,0);
  });
  await t.test('signed failed webhook replay is atomic, current-state based, mode checked and audited once',async()=>{
    await pool.query("UPDATE ysong_account_access SET billing_provider='stripe',billing_live=false,billing_customer_id=$2,billing_subscription_id=$3 WHERE user_id=$1",[user,'cus_'+user,'sub_'+user]);
    const event={id:'evt_failed_regression',type:'customer.subscription.updated',created:100,livemode:false,data:{object:{...subscription(user),status:'past_due'}}};events.set(event.id,event);
    failStripe=true;assert.equal((await signed(event)).status,503);failStripe=false;
    assert.equal((await pool.query('SELECT count(*) FROM ysong_billing_events WHERE event_id=$1',[event.id])).rows[0].count,'0');
    const path='/api/admin/recovery/billing-events/'+event.id+'/replay';
    assert.equal((await request(path,{reason},user)).status,403);
    wrongMode=true;assert.equal((await request(path,{reason})).status,409);wrongMode=false;
    assert.equal((await pool.query('SELECT resolved_at FROM ysong_billing_failures WHERE event_id=$1',[event.id])).rows[0].resolved_at,null);
    assert.equal((await request(path,{reason})).data.applied,true);
    assert.equal((await request(path,{reason})).data.duplicate,true);
    assert.equal((await signed(event)).data.duplicate,true);
    const a=await service.account(pool,user);assert.equal(a.plan_id,'pro');assert.equal(a.override_plan_id,'pro');assert.equal(a.override_quota,30);assert.equal(a.role,'user');
    assert.equal((await pool.query("SELECT count(*) FROM ysong_admin_audit WHERE action='billing_reconciliation' AND after_state->>'requestKey'=$1",[event.id])).rows[0].count,'1');
    const body={reason,requestKey:'current-subscription-regression'},reconcile='/api/admin/recovery/billing/'+user+'/reconcile';
    assert.equal((await request(reconcile,body)).data.applied,true);const reads=stripeReads;
    assert.equal((await request(reconcile,body)).data.duplicate,true);assert.equal(stripeReads,reads);
  });
  await t.test('billing recovery rolls back when operator access changes during Stripe retrieval',async()=>{
    const before=await countAudit();let reads=0;
    onRetrieve=async()=>{if(++reads===2)await pool.query("UPDATE ysong_account_access SET role='user' WHERE user_id=$1",[admin]);};
    try{
      const r=await request('/api/admin/recovery/billing/'+user+'/reconcile',{reason,requestKey:'revoked-during-retrieval'});
      assert.equal(r.status,403);assert.equal(r.data.error,'admin_required');assert.equal(reads,2);
      assert.equal((await pool.query("SELECT count(*) FROM ysong_billing_events WHERE event_id LIKE '%revoked-during-retrieval'")).rows[0].count,'0');
      assert.equal(await countAudit(),before);
    }finally{onRetrieve=async()=>{};await pool.query("UPDATE ysong_account_access SET role='admin' WHERE user_id=$1",[admin]);}
  });
  await t.test('normal admin cannot link, reconcile or replay billing for protected accounts',async()=>{
    for(const target of [superadmin,peer]){
      const before=await countAudit();
      const path='/api/admin/recovery/billing/'+target;
      assert.equal((await request(path+'/link-profile',{reason,customerId:'cus_'+target,subscriptionId:'sub_'+target})).status,403);
      await pool.query("UPDATE ysong_account_access SET billing_provider='stripe',billing_live=false,billing_customer_id=$2,billing_subscription_id=$3 WHERE user_id=$1",[target,'cus_'+target,'sub_'+target]);
      assert.equal((await request(path+'/reconcile',{reason,requestKey:'protected-reconcile'})).status,403);
      const event={id:'evt_protected_'+target,type:'customer.subscription.updated',created:100,livemode:false,data:{object:subscription(target)}};events.set(event.id,event);
      await pool.query("INSERT INTO ysong_billing_failures(live,event_id,event_type,error_code) VALUES(false,$1,$2,'fixture_failure')",[event.id,event.type]);
      assert.equal((await request('/api/admin/recovery/billing-events/'+event.id+'/replay',{reason})).status,403);
      assert.equal((await pool.query('SELECT count(*) FROM ysong_billing_events WHERE event_id=$1',[event.id])).rows[0].count,'0');
      const invoice={...event,id:'evt_protected_invoice_'+target,type:'invoice.payment_failed',data:{object:{id:'in_fixture',customer:'cus_'+target}}};events.set(invoice.id,invoice);
      await pool.query("INSERT INTO ysong_billing_failures(live,event_id,event_type,error_code) VALUES(false,$1,$2,'fixture_failure')",[invoice.id,invoice.type]);
      assert.equal((await request('/api/admin/recovery/billing-events/'+invoice.id+'/replay',{reason})).status,403);
      assert.equal((await pool.query('SELECT resolved_at FROM ysong_billing_failures WHERE event_id=$1',[invoice.id])).rows[0].resolved_at,null);
      assert.equal(await countAudit(),before);
    }
    // Superadmin retains operational recovery access, including its own exempt records.
    assert.equal((await request('/api/admin/recovery/billing/'+peer+'/reconcile',{reason,requestKey:'superadmin-reconcile'},superadmin)).status,200);
    assert.equal((await request('/api/admin/recovery/billing/'+superadmin+'/reconcile',{reason,requestKey:'superadmin-self-recovery'},superadmin)).status,200);
  });
  await t.test('late consumption and refund settle the original quota period only',async()=>{
    const owner=crypto.randomUUID();await pool.query('INSERT INTO users(id,email) VALUES($1,$2)',[owner,'late@example.invalid']);
    await service.adminAction(admin,owner,'override',{planId:'pro',quota:3},reason);
    const old=await service.reserve(owner,{requestKey:'previous-period',quantity:2,source:{instructions:'fixture'}});
    await pool.query("UPDATE ysong_quota_periods SET starts_at=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'-interval '1 month',ends_at=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' WHERE id=$1",[old.batch.quota_period_id]);
    const current=await service.reserve(owner,{requestKey:'current-period',source:{instructions:'fixture'}});
    await Promise.all([service.reconcile(old.versions[0].id,'ready'),service.reconcile(old.versions[1].id,'failed')]);
    const periods=(await pool.query('SELECT id,used,reserved FROM ysong_quota_periods WHERE user_id=$1 ORDER BY starts_at',[owner])).rows;
    assert.deepEqual(periods,[{id:old.batch.quota_period_id,used:1,reserved:0},{id:current.batch.quota_period_id,used:0,reserved:1}]);
  });
});
