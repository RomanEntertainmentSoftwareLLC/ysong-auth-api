import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import crypto from 'node:crypto';import pg from 'pg';import express from 'express';
import {createSaasService} from '../src/saas/service.mjs';import {registerSaasRoutes} from '../src/saas/routes.mjs';import {applySubscriptionEvent} from '../src/saas/billing.mjs';import {publicPlan} from '../src/saas/plans.mjs';import {classifyCost,createMeteringGate,assertPaidBoundary} from '../src/saas/metering.mjs';import {createGovernance,initialModeration} from '../src/saas/governance.mjs';import {createSessionJobs} from '../src/saas/jobs.mjs';
test('cost classification excludes deterministic DSP/file operations and covers exposed AI executors',()=>{
 for(const path of ['/chat','/api/rooms/abc/ai/respond','/api/critique/ai-summary'])assert.equal(classifyCost(path),'assistant');
 for(const path of ['/api/artwork/generate','/api/stem-composer/generate','/api/composer/plan'])assert.equal(classifyCost(path),'disabled');
 assert.equal(classifyCost('/api/generations/batches'),'quota');for(const path of ['/api/uploads','/api/vocal-midi','/api/world/tracks','/api/mixer'])assert.equal(classifyCost(path),'free');assert.throws(assertPaidBoundary,/unmetered_provider/);
});
test('catalog exposes actual configuration without provider references or invented unlimited quotas',()=>{const p=publicPlan({id:'basic',name:'YSong Basic',monthly_price_cents:999,currency:'usd',billing_interval:'month',monthly_generation_quota:null,billing_prices:{'stripe:live':'secret-reference'},available:true,capabilities:{}},'live',true);assert.equal(p.available,false);assert.equal(p.monthlyPriceCents,999);assert.ok(!JSON.stringify(p).includes('secret-reference'));});
test('artwork MIME and magic bytes require review, without fabricated visual classification',()=>{assert.equal(initialModeration('image/jpeg'),'needs_review');assert.equal(initialModeration('audio/wav',Buffer.from([137,80,78,71])),'needs_review');assert.equal(initialModeration('audio/wav',Buffer.from('RIFFmock')),'clear');});
test('isolated launch boundaries: billing, metering, governance and render reconciliation',{skip:!process.env.TEST_SAAS_DATABASE_URL},async t=>{
 const url=new URL(process.env.TEST_SAAS_DATABASE_URL);if(!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/ysong_saas_validation')throw new Error('Dedicated loopback fixture required');
 const schema=`launch_${crypto.randomUUID().replaceAll('-','')}`,root=new pg.Pool({connectionString:url.href});await root.query(`CREATE SCHEMA ${schema}`);const pool=new pg.Pool({connectionString:url.href,options:`-c search_path=${schema}`,max:10});t.after(async()=>{await pool.end();await root.end();});
 await pool.query("CREATE TABLE users(id uuid PRIMARY KEY,email text,display_name text,created_at timestamptz DEFAULT now());CREATE TABLE user_client_state(user_id uuid PRIMARY KEY,state jsonb DEFAULT '{}',updated_at timestamptz DEFAULT now());CREATE TABLE world_releases(id uuid PRIMARY KEY,artwork_object_key text);CREATE TABLE world_tracks(id uuid PRIMARY KEY,release_id uuid,status text,audio_object_key text)");
 const admin=crypto.randomUUID(),user=crypto.randomUUID();await pool.query('INSERT INTO users(id,email) VALUES($1,$2),($3,$4)',[admin,'psychopathetica@gmail.com',user,'launch@example.invalid']);const sql=await fs.readFile(new URL('../src/saas/schema.sql',import.meta.url),'utf8');await pool.query(sql);await pool.query(sql);
 await pool.query("UPDATE ysong_plans SET monthly_generation_quota=20,capabilities='{\"generation\":true,\"assistant\":true,\"artwork\":true,\"uploads\":true}',usage_limits='{\"assistant\":2}',available=true,billing_prices=jsonb_build_object('stripe:test','price_'||id)");
 const service=createSaasService(pool),app=express();app.use(express.json());const auth=async(req,res,next)=>{const id=req.get('authorization');if(![admin,user].includes(id))return res.sendStatus(401);try{await service.access(id,Math.floor(Date.now()/1000));req.user={id,issuedAt:Math.floor(Date.now()/1000)};next();}catch(e){res.status(e.status??503).json({error:e.code});}};
 let checkoutCalls=0,portalCalls=0;const stripe={customers:{create:async()=>({id:'cus_fixture'})},prices:{retrieve:async id=>({active:true,livemode:false,currency:'usd',unit_amount:id==='price_basic'?999:id==='price_pro'?1999:2999,recurring:{interval:'month'}})},checkout:{sessions:{create:async()=>{checkoutCalls++;return{id:'cs_fixture',url:'https://checkout.stripe.com/fixture'};}}},billingPortal:{sessions:{create:async()=>{portalCalls++;return{url:'https://billing.stripe.com/fixture'};}}}};
 registerSaasRoutes(app,{pool,service,requireAuth:auth,enabled:()=>true,env:{BILLING_MODE:'test',BILLING_RETURN_URL:'http://localhost/app'},billingAdapter:()=>({stripe,live:false})});
 const governance=createGovernance({pool,service,enabled:()=>true,assertOwnedObjectKey:(uid,key)=>{if(typeof key!=='string'||!key.startsWith(`user-uploads/${uid}/`))throw new Error('foreign object');return key;}});governance.register(app,auth);
 app.use(createMeteringGate({pool,service,requireAuth:auth,enabled:()=>true}));let assistantCalls=0;app.post('/chat',(_req,res)=>{assertPaidBoundary();assistantCalls++;res.json({answer:'mocked'});});
 let renders=0,failRender=true;const jobs=createSessionJobs({pool,service,enabled:()=>true,provider:()=>({provider:'cloudflare',model:'minimax/music-2.6'}),generate:async()=>{renders++;if(failRender)throw new Error('timeout');return{audio:Buffer.from('fixture audio')};},persist:async(uid,id)=>`user-uploads/${uid}/generations/Generation-${id}.wav`,inspectArtifact:async()=>({bytes:12,hash:'verified-fixture'})});jobs.register(app,auth);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));const base=`http://127.0.0.1:${server.address().port}`;
 const request=async(path,body,uid=user,key)=>{const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:uid,'Content-Type':'application/json',...(key?{'idempotency-key':key}:{})},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,data:await r.json().catch(()=>null)};};
 await t.test('checkout authorization, canonical pricing, spoof rejection, replay and pending lock',async()=>{
  assert.equal((await request('/api/billing/checkout',{planId:'pro',requestKey:'unauth-key'},'')).status,401);assert.equal((await request('/api/billing/checkout',{planId:'bogus',requestKey:'spoof-key'})).status,400);
  const catalog=(await request('/api/billing/catalog')).data.plans;assert.equal(catalog.find(p=>p.id==='basic').monthlyPriceCents,999);
  assert.equal((await request('/api/billing/checkout',{planId:'basic',requestKey:'checkout-key'})).status,503);assert.equal(checkoutCalls,0);
  await pool.query("UPDATE ysong_policy_versions SET active=true,approved=true,version='fixture-reviewed-v1',approval_reference='Fixture attorney review reference' WHERE policy_id IN ('terms','privacy','billing')");
  assert.equal((await request('/api/billing/checkout',{planId:'basic',requestKey:'checkout-key'})).status,403);assert.equal(checkoutCalls,0);
  await pool.query("INSERT INTO ysong_policy_acceptances(user_id,policy_id,version) SELECT $1,policy_id,version FROM ysong_policy_versions WHERE active AND approved",[user]);
  assert.equal((await request('/api/billing/checkout',{planId:'basic',requestKey:'checkout-key'})).status,200);assert.equal((await request('/api/billing/checkout',{planId:'basic',requestKey:'checkout-key'})).status,200);assert.equal(checkoutCalls,1);
  assert.equal((await request('/api/billing/checkout',{planId:'pro',requestKey:'other-checkout'})).status,409);assert.equal((await request('/api/billing/portal',{})).status,200);assert.equal(portalCalls,1);
  assert.equal((await request(`/api/admin/accounts/${user}/usage`)).status,403);assert.equal((await request(`/api/admin/accounts/${user}/usage`,undefined,admin)).status,200);
 });
 await t.test('authoritative upgrade/downgrade/cancel and stale webhook cannot grant via redirect',async()=>{
  const sub={id:'sub_fixture',customer:'cus_fixture',livemode:false,status:'active',current_period_start:100,current_period_end:4102444800,cancel_at_period_end:false,items:{data:[{price:{id:'price_pro',product:'prod_fixture'}}]}};
  const event={id:'evt_pro',type:'customer.subscription.updated',created:100,livemode:false};await applySubscriptionEvent(service,event,sub);assert.equal((await service.summary(user)).planId,'pro');
  await applySubscriptionEvent(service,{...event,id:'evt_basic',created:200},{...sub,cancel_at_period_end:true,items:{data:[{price:{id:'price_basic'}}]}});assert.equal((await request('/api/billing/account')).data.cancellationScheduled,true);
  await applySubscriptionEvent(service,{...event,id:'evt_old',created:150},sub);assert.equal((await service.summary(user)).planId,'basic');
  await applySubscriptionEvent(service,{...event,id:'evt_cancel',type:'customer.subscription.deleted',created:300},{...sub,status:'canceled'});assert.equal((await service.summary(user)).planId,'free');
 });
 await t.test('assistant limits, duplicate suppression, admin exemption and persisted usage',async()=>{
  assert.equal((await request('/chat',{prompt:'test'})).status,400);assert.equal((await request('/chat',{prompt:'test'},user,'assistant-key')).status,200);assert.equal((await request('/chat',{prompt:'test'},user,'assistant-key')).status,409);
  assert.equal((await request('/chat',{prompt:'next'},user,'assistant-key-2')).status,200);assert.equal((await request('/chat',{prompt:'over'},user,'assistant-key-3')).status,409);
  assert.equal((await request('/chat',{prompt:'admin'},admin)).status,200);assert.equal(assistantCalls,3);assert.equal((await pool.query('SELECT * FROM ysong_usage_events WHERE admin_exempt=true')).rows.length,1);
 });
 await t.test('provider disabled before costly call, and provider helper rejects unmetered future calls',async()=>{
  await pool.query("UPDATE ysong_provider_controls SET enabled=false WHERE id='openai'");assert.equal((await request('/chat',{prompt:'blocked'},admin)).status,503);assert.equal(assistantCalls,3);await pool.query("UPDATE ysong_provider_controls SET enabled=true WHERE id='openai'");assert.throws(assertPaidBoundary,/unmetered_provider/);
 });
 const objectKey=`user-uploads/${user}/art.png`;
 await t.test('policy version acceptance is explicit, stale versions rejected and reacceptance supported',async()=>{
  assert.equal((await request('/api/account/policies')).data.configured,false);
  await pool.query("UPDATE ysong_policy_versions SET approved=true,active=true WHERE policy_id='upload-rights'");assert.equal((await request('/api/account/policies/accept',{policyId:'upload-rights',version:'attorney-review-required',accepted:true})).status,409);
  await pool.query("UPDATE ysong_policy_versions SET version='fixture-reviewed-v1',approval_reference='Fixture attorney review reference' WHERE policy_id='upload-rights'");assert.equal((await request('/api/account/policies/accept',{policyId:'upload-rights',version:'old',accepted:true})).status,409);
  assert.equal((await request('/api/account/policies/accept',{policyId:'upload-rights',version:'fixture-reviewed-v1',accepted:false})).status,400);assert.equal((await request('/api/account/policies/accept',{policyId:'upload-rights',version:'fixture-reviewed-v1',accepted:true})).status,200);
  await pool.query("UPDATE ysong_policy_versions SET active=false WHERE policy_id='upload-rights';INSERT INTO ysong_policy_versions VALUES('upload-rights','reviewed-v2','/legal',true,true,true,'Fixture attorney review reference')");
  assert.equal((await request('/api/account/policies')).data.policies.find(p=>p.policy_id==='upload-rights').accepted_at,null);assert.equal((await request('/api/account/policies/accept',{policyId:'upload-rights',version:'reviewed-v2',accepted:true})).status,200);
 });
 await t.test('new artwork review, attestation, admin override, changed bytes invalidate approval',async()=>{
  await governance.recordUpload(user,objectKey,Buffer.from('image'),'image/png');await assert.rejects(governance.assertPublic(objectKey),/content_requires_review/);
  assert.equal((await request('/api/content/rights/attest',{objectKey,accepted:true,sourceReference:'original work'})).status,200);
  assert.equal((await request('/api/admin/content/review',{objectKey,state:'clear',approveRights:true,reason:'Manually inspected allowed swimwear'},user)).status,403);
  assert.equal((await request('/api/admin/content/review',{objectKey,state:'clear',approveRights:true,reason:'Manually inspected allowed swimwear'},admin)).status,200);await governance.assertPublic(objectKey);
  await governance.recordUpload(user,objectKey,Buffer.from('image'),'image/png');await governance.assertPublic(objectKey);assert.equal((await pool.query('SELECT evidence FROM ysong_content_reviews WHERE object_key=$1',[objectKey])).rows[0].evidence.reason,'Manually inspected allowed swimwear');
  await governance.recordUpload(user,objectKey,Buffer.from('changed bytes'),'image/png');await assert.rejects(governance.assertPublic(objectKey),/content_requires_review/);assert.equal((await pool.query('SELECT rights_record FROM ysong_content_reviews WHERE object_key=$1',[objectKey])).rows[0].rights_record,null);
 });
 await t.test('hidden/restored content is audited, files are retained, takedown/counter-notice cases persist',async()=>{
  const id=crypto.randomUUID();await pool.query('INSERT INTO world_tracks(id,status,audio_object_key) VALUES($1,$2,$3)',[id,'published',objectKey]);
  await request('/api/admin/content/review',{objectKey,state:'hidden',reason:'Content review pending documented evidence'},admin);assert.equal((await pool.query('SELECT status FROM world_tracks WHERE id=$1',[id])).rows[0].status,'hidden');
  await request('/api/admin/content/review',{objectKey,state:'restored',reason:'Human review completed with retained content'},admin);assert.equal((await pool.query('SELECT status FROM world_tracks WHERE id=$1',[id])).rows[0].status,'published');
  const c=await request('/api/takedowns',{objectKey,contactReference:'claimant@example.invalid',claim:'Fixture claim requires human legal review'});assert.equal(c.status,201);assert.equal((await request(`/api/takedowns/${c.data.id}/counter-notice`,{notice:'Fixture owner counter notice for legal review'})).status,200);
  assert.equal((await request(`/api/admin/takedowns/${c.data.id}/decision`,{state:'removed',reason:'Reviewed fixture removal decision'},admin)).status,200);assert.equal((await request('/api/admin/takedowns',undefined,admin)).data.cases[0].notification_state,'pending');
  assert.equal((await pool.query('SELECT status FROM world_tracks WHERE id=$1',[id])).rows[0].status,'hidden');
  await request(`/api/admin/takedowns/${c.data.id}/decision`,{state:'restored',reason:'Reviewed counter notice restoration'},admin);assert.equal((await pool.query('SELECT status FROM world_tracks WHERE id=$1',[id])).rows[0].status,'published');
 });
 const plan={projectName:'Recovery',bpm:120,totalBars:1,sigNum:4,sigDen:4,tracks:[{id:'voice',name:'Voice',mode:'audio',renderInstructions:'Isolated vocal'}]};
 await t.test('uncertain render reserves once; confirmed failure releases once and suppresses blind retry',async()=>{
  const r=await request('/api/generations/batches',{quantity:1,requestKey:'uncertain-launch',prompt:'vocal',lyrics:'lyrics',plan});await jobs.tick();const id=r.data.versions[0].id;
  assert.equal((await service.summary(user)).reserved,1);assert.equal((await request(`/api/generations/${id}/retry`,{})).status,409);
  const path=`/api/admin/generations/${id}/parts/voice/resolve`,body={outcome:'confirmed_failure',reason:'Provider support confirmed no render was created',providerReference:'support-fixture'};
  assert.equal((await request(path,body,user)).status,403);assert.equal((await request(path,body,admin)).status,200);assert.equal((await request(path,body,admin)).data.duplicate,true);await jobs.tick();assert.equal((await service.summary(user)).reserved,0);assert.equal(renders,1);
 });
 await t.test('confirmed stored success verifies exact owned key, finalizes project and charges once',async()=>{
  const r=await request('/api/generations/batches',{quantity:1,requestKey:'recovered-launch',prompt:'vocal',lyrics:'lyrics',plan});await jobs.tick();const id=r.data.versions[0].id,path=`/api/admin/generations/${id}/parts/voice/resolve`;
  assert.equal((await request(path,{outcome:'confirmed_success',objectKey:'foreign.wav',reason:'Recovered artifact inspected'},admin)).status,400);
  const body={outcome:'confirmed_success',objectKey:`user-uploads/${user}/generations/Generation-${id}-voice.wav`,reason:'Recovered owned artifact inspected'};
  assert.equal((await request(path,body,admin)).status,200);await jobs.tick();assert.equal((await request(path,body,admin)).data.duplicate,true);assert.equal((await service.summary(user)).used,1);assert.equal((await request(`/api/generations/${id}/project`)).status,200);assert.equal(renders,2);
 });
});
