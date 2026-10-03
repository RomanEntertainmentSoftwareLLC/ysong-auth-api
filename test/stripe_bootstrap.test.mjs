import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {bootstrapStripeTest,testCatalog} from '../src/saas/stripe-bootstrap.mjs';
import {applyLaunchConfiguration,validateLaunchConfiguration} from '../src/saas/configuration.mjs';

const env={STRIPE_SECRET_KEY:'sk_test_fixture',BILLING_MODE:'test'};
function fixture() {
  const products=[],prices=[],writes=[];
  const stripe={};
  for(const [kind,rows] of [['products',products],['prices',prices]]) stripe[kind]={
    list:async function*(){for(const row of rows) yield row;},
    create:async(body,options)=>{
      writes.push({kind,body,options});
      const row={id:(kind==='products'?'prod_':'price_')+rows.length,active:true,livemode:false,
        ...(kind==='prices'?{type:'recurring',billing_scheme:'per_unit'}:{}),...structuredClone(body)};
      rows.push(row);return row;
    },
  };
  return {products,prices,writes,stripe,run:options=>bootstrapStripeTest({env,createClient:()=>stripe,...options})};
}

test('offline check describes paid catalog and Free without constructing a client',async()=>{
  const result=await bootstrapStripeTest({env:{},createClient:()=>assert.fail('network')});
  assert.equal(result.status,'offline');
  assert.deepEqual(result.plans.slice(1).map(p=>p.unitAmount),[999,1999,2999]);
  assert.equal(result.plans[0].action,'no-subscription');
  await assert.rejects(bootstrapStripeTest({env:{},applyTestMode:true}));
});

test('live, restricted live, unknown and mismatched modes fail before client construction',async()=>{
  for(const key of ['sk_live_fixture','rk_live_fixture','pk_test_fixture','invalid','sk_test_'])
    await assert.rejects(bootstrapStripeTest({env:{STRIPE_SECRET_KEY:key},createClient:()=>assert.fail('network')}));
  await assert.rejects(bootstrapStripeTest({env:{...env,BILLING_MODE:'live'},createClient:()=>assert.fail('network')}));
});

test('check is read-only; apply and rerun reuse stable metadata with deterministic idempotency keys',async()=>{
  const f=fixture();assert.equal((await f.run()).plans[1].action,'create-product-and-price');assert.equal(f.writes.length,0);
  const first=await f.run({applyTestMode:true}),second=await f.run({applyTestMode:true});
  assert.equal(f.writes.length,6);assert.equal(f.products.length,3);assert.equal(f.prices.length,3);
  assert.deepEqual(second.plans.map(p=>[p.productId,p.priceId]),first.plans.map(p=>[p.productId,p.priceId]));
  assert.ok(second.plans.slice(1).every(p=>p.action==='reuse'));
  for(const w of f.writes) assert.match(w.options.idempotencyKey,/^ysong:test:/);
  assert.deepEqual(f.prices.map(p=>p.unit_amount),testCatalog.map(p=>p.amount));
  assert.ok(f.products.every(p=>p.metadata.ysong_plan!=='free'));
});

test('partial creation resumes and metadata discovery traverses the entire iterator',async()=>{
  const f=fixture();
  for(let i=0;i<105;i++) f.products.push({id:'prod_unrelated_'+i,active:true,livemode:false,metadata:{}});
  f.products.push({id:'prod_existing',active:true,livemode:false,metadata:{ysong_plan:'basic'}});
  const create=f.stripe.prices.create;let fail=true;
  f.stripe.prices.create=async(...args)=>{if(fail){fail=false;throw new Error('transient');}return create(...args);};
  await assert.rejects(f.run({applyTestMode:true}));
  const result=await f.run({applyTestMode:true});assert.equal(result.plans[1].productId,'prod_existing');
  assert.equal(f.products.filter(p=>p.metadata.ysong_plan==='basic').length,1);
});

test('conflicts anywhere in catalog fail before writes, including archived and wrong terms',async()=>{
  for(const mutate of [
    f=>f.products.push({...f.products[2],id:'prod_duplicate'}),
    f=>{f.products[2].active=false;},f=>{f.prices[2].active=false;},
    f=>{f.prices[2].unit_amount=1;},f=>{f.prices[2].currency='eur';},
    f=>{f.prices[2].recurring.interval_count=12;},f=>{f.prices[2].recurring.usage_type='metered';},
    f=>{f.prices[2].product='prod_wrong';},f=>{f.prices[2].livemode=true;},
    f=>{f.products[2].livemode=true;},f=>{delete f.prices[2].metadata.ysong_plan;},
    f=>f.prices.push({...f.prices[2],id:'price_duplicate'}),
  ]) {
    const f=fixture();await f.run({applyTestMode:true});mutate(f);
    f.products.splice(0,1);f.prices.splice(0,1);f.writes.length=0;
    await assert.rejects(f.run({applyTestMode:true}));assert.equal(f.writes.length,0);
  }
});

test('references integrate through reviewed configuration into stripe:test only',async()=>{
  const f=fixture(),result=await f.run({applyTestMode:true});
  const c=validateLaunchConfiguration({mode:result.mode,databaseHost:'localhost',superadminUserId:'00000000-0000-4000-8000-000000000001',
    plans:result.plans.map(({id,priceId,productId})=>({id,priceId,productId,quota:5,storageQuotaBytes:null,capabilities:{generation:false,assistant:false,uploads:false,artwork:false},assistantLimit:null,available:false})),
    policies:['terms','privacy','upload-rights','billing','generated-output','bridge-license'].map(id=>({id,version:'reviewed-v1',url:'https://example.com/'+id,approvalReference:'Fixture review reference'}))});
  const updates=[];
  await applyLaunchConfiguration({query:async(sql,args)=>{
    if(sql.startsWith('SELECT id,monthly'))return {rows:[{id:'free',monthly_price_cents:0},...testCatalog.map(p=>({id:p.id,monthly_price_cents:p.amount}))].map(p=>({...p,currency:'usd',billing_interval:'month'}))};
    if(sql.startsWith('SELECT 1'))return {rows:[{}]};
    if(sql.startsWith('UPDATE ysong_plans'))updates.push(args);
    return {rows:[]};
  }},c);
  assert.deepEqual(updates[0][6],{});
  assert.deepEqual(updates.slice(1).map(p=>p[6]),result.plans.slice(1).map(p=>({'stripe:test':p.priceId})));
});

test('CLI defaults offline, rejects unsafe flags/key without revealing credentials',()=>{
  for(const [args,key,status] of [[[], '',0],[['--dry-run'],'',0],[['--apply'],'',1],[['--apply-test-mode'],'',1],[['--check'],'sk_live_private_fixture',1],[['--apply-test-mode','--check'],'',1]]) {
    const child=spawnSync(process.execPath,['scripts/bootstrap-stripe-test.mjs',...args],{encoding:'utf8',env:{...process.env,STRIPE_SECRET_KEY:key,BILLING_MODE:'test'}});
    assert.equal(child.status,status,child.stderr);
    if(key)assert.ok(!(child.stdout+child.stderr).includes(key));
  }
});
