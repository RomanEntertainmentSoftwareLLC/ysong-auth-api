import test from 'node:test';
import assert from 'node:assert/strict';
import {approvedPolicy,POLICY_IDS,ACCEPTANCE_POLICY_IDS} from '../src/saas/policies.mjs';
import {validateLaunchConfiguration} from '../src/saas/configuration.mjs';

test('all launch references are mandatory while operational rules are not acceptance prompts',()=>{
 assert.equal(POLICY_IDS.length,9);
 const base={approved:true,active:true,approval_reference:'Fixture review reference',version:'reviewed-v1',url:'https://example.invalid/legal/v1'};
 for(const policy_id of POLICY_IDS){
  const p={...base,policy_id,required:ACCEPTANCE_POLICY_IDS.includes(policy_id)};
  assert.equal(approvedPolicy(p),true,policy_id);
  for(const change of [{approved:false},{active:false},{version:'attorney-review-required'},{version:'draft-v1'},{version:'placeholder-v1'},{url:'/legal'},{approval_reference:'short'},{required:!p.required}])
   assert.equal(approvedPolicy({...p,...change}),false,policy_id);
 }
});

test('configuration cannot omit operational legal references or substitute draft versions',()=>{
 const plans=['free','basic','pro','premium'].map(id=>({id,quota:1,storageQuotaBytes:null,capabilities:{generation:true,assistant:false,uploads:true,artwork:false},assistantLimit:null,available:true,priceId:id==='free'?null:'price_'+id,productId:id==='free'?null:'prod_'+id}));
 const c={mode:'test',databaseHost:'localhost',superadminUserId:'00000000-0000-4000-8000-000000000001',plans,policies:POLICY_IDS.map(id=>({id,version:'reviewed-v1',url:'https://example.invalid/legal/'+id+'/v1',approvalReference:'Fixture review reference'}))};
 assert.equal(validateLaunchConfiguration(c).policies.length,9);
 assert.throws(()=>validateLaunchConfiguration({...c,policies:c.policies.slice(0,-1)}));
 assert.throws(()=>validateLaunchConfiguration({...c,policies:c.policies.map(p=>p.id==='moderation'?{...p,version:'draft-v1'}:p)}));
});

test('preflight fails closed for every missing legal reference and keeps human review manual',async()=>{
 const {legalGates,readiness}=await import('../src/saas/preflight.mjs');const policies=POLICY_IDS.map(policy_id=>({policy_id,required:ACCEPTANCE_POLICY_IDS.includes(policy_id),active:true,approved:true,version:'reviewed-v1',url:'https://example.invalid/legal/v1',approval_reference:'Fixture only review reference'}));
 for(const id of POLICY_IDS){const gates=legalGates(policies.filter(p=>p.policy_id!==id));assert.equal(gates.find(g=>g.gate==='Approved policy: '+id).status,'NOT CONFIGURED');assert.equal(gates.at(-1).status,'ATTORNEY REVIEW REQUIRED');assert.notEqual(readiness(gates),'PASS');}
 assert.equal(legalGates(policies).at(-1).status,'MANUAL ACTION REQUIRED');assert.equal(readiness(legalGates(policies)),'MANUAL ACTION REQUIRED');assert.equal(readiness([{status:'ATTORNEY REVIEW REQUIRED'}]),'ATTORNEY REVIEW REQUIRED');assert.equal(approvedPolicy({...policies[0],policy_id:'unknown',required:false}),false);assert.equal(approvedPolicy({...policies[0],approved:'true'}),false);
});
