import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import express from 'express';
import Stripe from 'stripe';
import {applySubscriptionEvent,registerBillingWebhook,billingWebhookEvents,verifyBillingEvent} from '../src/saas/billing.mjs';
import {configureStripeTestWebhook} from '../src/saas/stripe-webhook-test.mjs';
import {registerRecoveryRoutes} from '../src/saas/recovery.mjs';

const sub=(overrides={})=>({id:'sub_fixture',customer:'cus_fixture',livemode:false,status:'active',current_period_start:100,current_period_end:4102444800,
  cancel_at_period_end:false,items:{data:[{price:{id:'price_pro',product:'prod_pro'}}]},...overrides});
const event=(id='evt_fixture',created=100,type='customer.subscription.updated',object=sub())=>({id,created,type,livemode:false,data:{object}});

// Transactional SQL fixture: serialize transactions, roll back ledger/access/notices
// together, and reject unmodeled SQL rather than silently succeeding.
function fixture() {
  let state={account:{user_id:'user',billing_customer_id:'cus_fixture',billing_live:false,billing_subscription_id:null,plan_id:'free',subscription_status:'none',last_billing_event_at:0,role:'superadmin',override_plan_id:'premium'},events:{},notices:{},failures:{},audits:[]};
  let queue=Promise.resolve(),locked=false;
  const query=async(sql,p)=>{
    if(sql.startsWith('INSERT INTO ysong_billing_events')){const key=`${p[1]}:${p[2]}`;if(state.events[key])return {rows:[]};state.events[key]={};return {rows:[{event_id:p[2]}]};}
    if(sql.startsWith('SELECT')&&sql.includes('FROM ysong_account_access')){locked=sql.includes('FOR UPDATE');return {rows:p[0]===state.account.billing_live&&p[1]===state.account.billing_customer_id?[structuredClone(state.account)]:[]};}
    if(sql.startsWith('SELECT id FROM ysong_plans'))return {rows:p[0]==='stripe:test'&&['price_pro','price_basic'].includes(p[1])?[{id:p[1].slice(6)}]:[]};
    if(sql.startsWith('UPDATE ysong_account_access')){for(const [i,key] of ['user_id','plan_id','subscription_status','billing_subscription_id','billing_price_id','billing_product_id','period_start','period_end','cancel_at_period_end','last_billing_event_at'].entries())state.account[key]=p[i];return {rows:[]};}
    if(sql.startsWith('UPDATE ysong_billing_events')){state.events[`${p[1]}:${p[2]}`].transition=p[3];return {rows:[]};}
    if(sql.startsWith('INSERT INTO ysong_notifications')){state.notices[p[0]]=p;return {rows:[]};}
    if(sql.startsWith('INSERT INTO ysong_admin_audit')){state.audits.push(p);return {rows:[]};}
    if(sql.startsWith('INSERT INTO ysong_billing_failures')){state.failures[p[1]]=p[3];return {rows:[]};}
    if(sql.startsWith('UPDATE ysong_billing_failures')){delete state.failures[p[1]];return {rows:[]};}
    throw new Error('Unmodeled SQL: '+sql);
  };
  const service={transaction(fn){const run=queue.then(async()=>{const before=structuredClone(state);locked=false;try{return await fn({query});}catch(e){state=before;throw e;}finally{locked=false;}});queue=run.catch(()=>{});return run;}};
  return {service,get state(){return state;},get locked(){return locked;}};
}

test('created/updated/deleted, renewal, cancellation/resume and payment states reconcile without changing overrides',async()=>{
  const f=fixture();let time=100;
  for(const [type,s,plan] of [
    ['created',sub(),'pro'],['updated',sub({cancel_at_period_end:true}),'pro'],
    ['updated',sub({items:{data:[{price:{id:'price_basic'}}]}}),'basic'],
    ['updated',sub({current_period_start:200,current_period_end:4102444900}),'pro'],
    ...['past_due','unpaid','incomplete','paused','trialing'].map(status=>['updated',sub({status}),status==='trialing'?'pro':'free']),
    ['deleted',sub({status:'canceled',items:{data:[]}}),'free']]) {
    const e=event('evt_'+time,time++,'customer.subscription.'+type,s);
    assert.deepEqual(await applySubscriptionEvent(f.service,e,s),{applied:true});
    assert.equal(f.state.account.plan_id,plan);
  }
  assert.equal(f.state.account.role,'superadmin');assert.equal(f.state.account.override_plan_id,'premium');
  assert.equal(f.state.account.subscription_status,'canceled');
});

test('transactional duplicate/replay, stale timestamps, equal-second cancellation and replaced subscription deletion',async()=>{
  const f=fixture(),e=event();let reads=0;
  const retrieve=async()=>{assert.equal(f.locked,true);reads++;return sub();};
  const results=await Promise.all(Array.from({length:8},()=>applySubscriptionEvent(f.service,e,sub(),null,retrieve)));
  assert.equal(results.filter(r=>r.applied).length,1);assert.equal(reads,1);assert.equal(Object.keys(f.state.notices).length,1);
  f.state.failures[e.id]='old failure';assert.equal((await applySubscriptionEvent(f.service,e,sub(),null,retrieve)).duplicate,true);assert.ok(!f.state.failures[e.id]);
  assert.deepEqual(await applySubscriptionEvent(f.service,event('evt_stale',99),sub(),null,retrieve),{stale:true});assert.equal(reads,1);
  await applySubscriptionEvent(f.service,event('evt_delete',100,'customer.subscription.deleted'),sub({status:'canceled'}));
  assert.deepEqual(await applySubscriptionEvent(f.service,event('evt_equal',100),sub()),{stale:true});
  await applySubscriptionEvent(f.service,event('evt_new',101),sub({id:'sub_new'}));
  assert.deepEqual(await applySubscriptionEvent(f.service,event('evt_old_delete',102,'customer.subscription.deleted'),sub({status:'canceled'})),{stale:true});
  assert.equal(f.state.account.billing_subscription_id,'sub_new');assert.equal(f.state.account.plan_id,'pro');
  const concurrent=fixture();let snapshots=0;
  const latest=async()=>{assert.ok(concurrent.locked);return ++snapshots===1?sub():sub({items:{data:[{price:{id:'price_basic'}}]}});};
  await Promise.all(['evt_a','evt_b'].map(id=>applySubscriptionEvent(concurrent.service,event(id),sub(),null,latest)));
  assert.equal(snapshots,2);assert.equal(concurrent.state.account.plan_id,'basic');
});

test('unknown customers/prices, ambiguous items, wrong modes/owners and malformed periods roll back and can retry',async()=>{
  for(const [s,code] of [[sub({customer:'cus_unknown'}),'billing_customer_not_linked'],[sub({livemode:true}),'billing_subscription_owner_or_mode_mismatch'],
    [sub({items:{data:[{price:{id:'unknown'}}]}}),'billing_price_not_configured'],[sub({items:{data:[...sub().items.data,...sub().items.data]}}),'billing_price_not_configured'],
    [sub({current_period_end:1}),'invalid_billing_period'],[sub({items:{data:[]}}),'billing_price_not_configured']]) {
    const f=fixture();await assert.rejects(applySubscriptionEvent(f.service,event(),s),new RegExp(code));
    assert.equal(Object.keys(f.state.events).length,0);assert.equal(f.state.account.plan_id,'free');
    assert.equal((await applySubscriptionEvent(f.service,event(),sub())).applied,true);
  }
  for(const s of [sub({id:'sub_wrong'}),sub({customer:'cus_wrong'}),sub({livemode:true})]) {
    const f=fixture();await assert.rejects(applySubscriptionEvent(f.service,event(),sub(),null,async()=>s),/owner_or_mode_mismatch/);assert.equal(Object.keys(f.state.events).length,0);
  }
  const f=fixture();await assert.rejects(applySubscriptionEvent(f.service,event('evt_bad_delete',100,'customer.subscription.deleted'),sub()),/invalid_deleted_subscription/);
  await applySubscriptionEvent(f.service,event(),sub());
  await assert.rejects(applySubscriptionEvent(f.service,event('evt_other',101),sub({id:'sub_other'})),/multiple_subscriptions/);
});

test('HTTP raw signatures, explicit flag, mode separation, authoritative fetch, retry and safe errors',async t=>{
  const f=fixture(),secret='whsec_fixture_only',env={BILLING_MODE:'test',BILLING_WEBHOOK_ENABLED:'1',STRIPE_WEBHOOK_SECRET:secret};
  let current=sub(),reads=0,fail=false;
  assert.throws(()=>verifyBillingEvent(event(),'unused',env),/invalid_webhook_signature/);
  const app=express();registerBillingWebhook(app,express,f.service,()=>false,env,()=>({stripe:{subscriptions:{retrieve:async()=>{reads++;assert.ok(f.locked);if(fail)throw new Error('sensitive SDK response');return current;}}}}));app.use(express.json());
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
  const send=async(e,options={})=>{const payload=JSON.stringify(e);const signature=Stripe.webhooks.generateTestHeaderString({payload,secret,...options});const r=await fetch(`http://127.0.0.1:${server.address().port}/api/billing/webhook`,{method:'POST',headers:{'content-type':'application/json','stripe-signature':signature},body:payload+(options.tamper?' ':'')});return {status:r.status,body:await r.json()};};
  assert.equal((await send(event(),{tamper:true})).status,400);assert.equal((await send(event(),{timestamp:1})).status,400);
  assert.equal((await send({...event(),livemode:true})).status,400);assert.equal(reads,0);
  assert.equal((await send(event('evt_foreign',100,'customer.subscription.created',sub({customer:'cus_unknown'})))).status,409);assert.equal(reads,0);
  env.BILLING_WEBHOOK_ENABLED='0';assert.equal((await send(event())).status,503);env.BILLING_WEBHOOK_ENABLED='1';
  current=sub({items:{data:[{price:{id:'price_basic'}}]}});
  assert.equal((await send(event('evt_create',100,'customer.subscription.created'))).status,200);assert.equal(f.state.account.plan_id,'basic');
  assert.equal((await send(event('evt_create',100,'customer.subscription.created'))).body.duplicate,true);assert.equal(reads,1);
  fail=true;const failed=await send(event('evt_retry',101));assert.deepEqual(failed,{status:503,body:{error:'billing_temporarily_unavailable'}});assert.ok(f.state.failures.evt_retry);assert.ok(!f.state.events['false:evt_retry']);
  fail=false;assert.equal((await send(event('evt_retry',101))).status,200);assert.ok(!f.state.failures.evt_retry);
  const before=reads;assert.equal((await send(event('evt_delete',102,'customer.subscription.deleted',sub({status:'canceled'})))).status,200);assert.equal(reads,before);assert.equal(f.state.account.plan_id,'free');
  const invoice=event('evt_invoice',103,'invoice.paid',{customer:'cus_fixture'});await send(invoice);await send(invoice);assert.equal(f.state.account.plan_id,'free');
  assert.equal((await send(event('evt_unknown_invoice',104,'invoice.payment_failed',{customer:'cus_unknown'}))).status,409);
  assert.equal((await send(event('evt_ignored',105,'customer.subscription.pending_update_applied'))).body.ignored,true);assert.equal(reads,before);
  const source=await fs.readFile(new URL('../src/index.js',import.meta.url),'utf8');assert.ok(source.indexOf('registerBillingWebhook(app,')<source.indexOf('app.use(express.json())'));
});

test('operator replay and reconciliation reuse the billing owner, audit once, and reject foreign/live snapshots',async t=>{
  const f=fixture(),user='00000000-0000-4000-8000-000000000001',admin='00000000-0000-4000-8000-000000000002';
  Object.assign(f.state.account,{user_id:user,role:'user',billing_subscription_id:'sub_fixture'});
  f.service.account=async(_c,id)=>id===admin?{role:'admin',account_status:'active'}:structuredClone(f.state.account);
  let current=sub(),replay=event('evt_failed',100,'customer.subscription.created'),reads=0;
  const pool={query:async(sql,p)=>{
    if(sql.startsWith('SELECT 1 FROM ysong_billing_events'))return {rows:f.state.events[`${p[1]}:${p[2]}`]?[{}]:[]};
    if(sql.startsWith('SELECT * FROM ysong_billing_failures'))return {rows:f.state.failures[p[1]]?[{event_id:p[1],event_type:replay.type}]:[]};
    throw new Error('Unmodeled recovery query');
  }};
  const app=express();app.use(express.json());registerRecoveryRoutes(app,{pool,service:f.service,enabled:()=>true,requireAuth:(req,_res,next)=>{req.user={id:admin};next();},billingAdapter:()=>({live:false,stripe:{subscriptions:{retrieve:async()=>{reads++;return current;}},events:{retrieve:async()=>replay}}})});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
  const send=async(path,body={})=>{const r=await fetch(`http://127.0.0.1:${server.address().port}`+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({reason:'Verified sandbox subscription state',...body})});return {status:r.status,body:await r.json()};};
  f.state.failures.evt_failed='billing_temporarily_unavailable';
  assert.equal((await send('/api/admin/recovery/billing-events/evt_failed/replay')).body.applied,true);assert.equal(f.state.audits.length,1);assert.equal(f.state.account.plan_id,'pro');assert.ok(!f.state.failures.evt_failed);
  const path=`/api/admin/recovery/billing/${user}/reconcile`;
  current=sub({status:'canceled'});assert.equal((await send(path,{requestKey:'reconcile-fixture'})).body.applied,true);assert.equal(f.state.account.plan_id,'free');
  const before=reads;assert.equal((await send(path,{requestKey:'reconcile-fixture'})).body.duplicate,true);assert.equal(reads,before);assert.equal(f.state.audits.length,2);
  for(const s of [sub({livemode:true}),sub({customer:'cus_foreign'}),sub({id:'sub_foreign'})]){current=s;assert.equal((await send(path,{requestKey:'invalid-fixture'})).status,409);}
  replay={...event('evt_failed_mode',200),livemode:true};f.state.failures.evt_failed_mode='failed';assert.equal((await send('/api/admin/recovery/billing-events/evt_failed_mode/replay')).status,409);
});

const operatorEnv={BILLING_MODE:'test',SAAS_ENABLED:'0',STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_TEST_WEBHOOK_URL:'https://sandbox.example.invalid/api/billing/webhook'};
function endpointFixture(initial=[]) {
  const endpoints=structuredClone(initial),writes=[];let clients=0;
  const createClient=()=>{clients++;return {webhookEndpoints:{list:async function*(){yield* endpoints;},create:async(body,options)=>{writes.push({body,options});const e={...body,id:'we_fixture',livemode:false,status:'enabled',secret:'whsec_NEVER_OUTPUT'};endpoints.push(e);return e;}}};};
  return {createClient,endpoints,writes,get clients(){return clients;}};
}
test('endpoint offline/check/apply/reuse are deterministic, test-only and redact secrets',async()=>{
  const f=endpointFixture();const offline=await configureStripeTestWebhook({env:{},createClient:f.createClient});assert.equal(offline.status,'offline');assert.equal(f.clients,0);assert.match(offline.manualBlocker,/SAAS_ENABLED=0/);
  const check=await configureStripeTestWebhook({env:operatorEnv,createClient:f.createClient});assert.equal(check.action,'create');assert.equal(f.writes.length,0);
  const apply=await configureStripeTestWebhook({env:operatorEnv,createClient:f.createClient,applyTestMode:true});assert.equal(apply.endpointId,'we_fixture');assert.equal(f.writes.length,1);assert.ok(!JSON.stringify(apply).includes('whsec_'));
  assert.equal((await configureStripeTestWebhook({env:operatorEnv,createClient:f.createClient,applyTestMode:true})).action,'reuse');assert.equal(f.writes.length,1);
  const g=endpointFixture();await configureStripeTestWebhook({env:operatorEnv,createClient:g.createClient,applyTestMode:true});assert.equal(g.writes[0].options.idempotencyKey,f.writes[0].options.idempotencyKey);
  assert.deepEqual(f.writes[0].body.enabled_events,billingWebhookEvents);
});
test('endpoint rejects unsafe credentials/URLs/configuration before mutation and scans all pages',async()=>{
  for(const patch of [{STRIPE_SECRET_KEY:'sk_live_hidden'},{STRIPE_SECRET_KEY:'rk_live_hidden'},{BILLING_MODE:'live'},{SAAS_ENABLED:'1'},{STRIPE_TEST_WEBHOOK_URL:'http://sandbox.invalid/api/billing/webhook'},{STRIPE_TEST_WEBHOOK_URL:'https://sandbox.invalid/wrong'},{STRIPE_TEST_WEBHOOK_URL:'https://user:secret@sandbox.invalid/api/billing/webhook'},{STRIPE_TEST_WEBHOOK_URL:operatorEnv.STRIPE_TEST_WEBHOOK_URL+'?secret=hidden'}]) {
    const f=endpointFixture();await assert.rejects(configureStripeTestWebhook({env:{...operatorEnv,...patch},createClient:f.createClient,applyTestMode:true}));assert.equal(f.clients,0);
  }
  await assert.rejects(configureStripeTestWebhook({env:{},applyTestMode:true}));
  const valid={id:'we_existing',url:operatorEnv.STRIPE_TEST_WEBHOOK_URL,livemode:false,status:'enabled',enabled_events:[...billingWebhookEvents]};
  for(const endpoints of [[valid,valid],[{...valid,status:'disabled'}],[{...valid,livemode:true}],[{...valid,enabled_events:['*']}],[{...valid,enabled_events:[]}],[{...valid,application:'ca_connect'}]]) {
    const f=endpointFixture(endpoints);await assert.rejects(configureStripeTestWebhook({env:operatorEnv,createClient:f.createClient,applyTestMode:true}));assert.equal(f.writes.length,0);
  }
});
test('operator CLI has deterministic offline output and redacted failure without dotenv',()=>{
  const env={...process.env};for(const key of ['STRIPE_SECRET_KEY','STRIPE_TEST_WEBHOOK_URL','BILLING_MODE','SAAS_ENABLED'])delete env[key];
  const run=(args=[],extra={})=>spawnSync(process.execPath,['scripts/configure-stripe-test-webhook.mjs',...args],{env:{...env,...extra},encoding:'utf8'});
  const check=run(['--check']);assert.equal(check.status,0);assert.equal(JSON.parse(check.stdout).status,'offline');assert.equal(run(['--dry-run']).stdout,check.stdout);
  for(const [args,extra] of [[['--apply-test-mode'],{}],[['--apply-live'],{}],[['--check'],{STRIPE_SECRET_KEY:'sk_live_DO_NOT_ECHO'}],[['--check','--apply-test-mode'],{}]]) {
    const r=run(args,extra);assert.equal(r.status,1);assert.ok(!r.stderr.includes('DO_NOT_ECHO'));assert.match(r.stderr,/No credential details/);
  }
});
