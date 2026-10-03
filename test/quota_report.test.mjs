import test from 'node:test';
import assert from 'node:assert/strict';
import {quotaReport} from '../src/saas/quota-report.mjs';
import {publicPlan} from '../src/saas/plans.mjs';

test('cost evidence is required before quota recommendations',()=>{
  assert.equal(quotaReport().status,'insufficient_evidence');
  assert.deepEqual(Object.values(quotaReport({providerCostEvidence:[{provider:'p',model:'m',costCentsPerGeneration:1}]}).productionQuotas),[null,null,null,null]);
  const report=quotaReport({providerCostEvidence:[{provider:'p',model:'m',source:'fixture invoice',costCentsPerGeneration:20},{provider:'q',model:'n',source:'fixture invoice',costCentsPerGeneration:25}],safetyMultiplier:2,monthlyCostBudgetCents:{free:0,basic:100,pro:200,premium:300}});
  assert.equal(report.status,'recommendations_only');assert.deepEqual(report.productionQuotas,{free:0,basic:2,pro:4,premium:6});
});
test('catalog availability requires configured quota, capability and mode-specific Stripe pair',()=>{
  const p={id:'basic',name:'Basic',monthly_price_cents:999,currency:'usd',billing_interval:'month',monthly_generation_quota:5,capabilities:{generation:true},available:true,billing_prices:{'stripe:test':'price_fixture'},billing_products:{'stripe:test':'prod_fixture'}};
  assert.equal(publicPlan(p,'test',true).available,true);assert.equal(publicPlan(p,'live',true).available,false);
  assert.equal(publicPlan({...p,monthly_generation_quota:null},'test',true).available,false);
  assert.equal(publicPlan({...p,capabilities:{}},'test',true).available,false);
  assert.equal(publicPlan({...p,id:'free',billing_prices:{},billing_products:{}},'test',true).available,true);
});
