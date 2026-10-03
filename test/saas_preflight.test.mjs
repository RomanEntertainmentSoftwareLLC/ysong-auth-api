import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {environmentGates,catalogGates,readiness} from '../src/saas/preflight.mjs';
import {POLICY_IDS} from '../src/saas/policies.mjs';

test('environment distinguishes absent, mismatched and disabled production configuration',()=>{
 const byName=env=>Object.fromEntries(environmentGates(env).map(g=>[g.gate,g.status]));
 assert.equal(byName({})['SaaS remains disabled'],'NOT CONFIGURED');
 assert.equal(byName({SAAS_ENABLED:'1'})['SaaS remains disabled'],'FAIL');
 assert.equal(byName({SAAS_ENABLED:'0',BILLING_MODE:'test',STRIPE_SECRET_KEY:'sk_live_fixture'})['Production billing mode/key'],'FAIL');
 assert.equal(byName({BILLING_MODE:'live',STRIPE_SECRET_KEY:'sk_live_fixture'})['Production billing mode/key'],'PASS');
 assert.equal(byName({STRIPE_WEBHOOK_SECRET:'bad'})['Webhook signing secret'],'FAIL');
 assert.equal(byName({BILLING_WEBHOOK_ENABLED:'0'})['Pre-enablement signed webhook ingestion'],'NOT CONFIGURED');
});
test('catalog and summary do not promote missing evidence to pass',()=>{
 assert.ok(catalogGates([]).every(g=>g.status==='NOT CONFIGURED'));
 assert.equal(readiness([{status:'PASS'},{status:'MANUAL ACTION REQUIRED'}]),'MANUAL ACTION REQUIRED');
 assert.equal(readiness([{status:'NOT CONFIGURED'},{status:'MANUAL ACTION REQUIRED'}]),'NOT CONFIGURED');
 assert.equal(readiness([{status:'FAIL'},{status:'PASS'}]),'FAIL');
});
test('CLI produces one parseable record and fails closed without production evidence',()=>{
 const result=spawnSync(process.execPath,['scripts/saas-preflight.mjs'],{cwd:new URL('../',import.meta.url),env:{PATH:process.env.PATH},encoding:'utf8',timeout:20000});
 assert.equal(result.status,1,result.stderr);
 const record=JSON.parse(result.stdout);
 assert.equal(record.status,'NOT CONFIGURED');
 assert.equal(record.gates.find(g=>g.gate==='Neon/read-only database connection').status,'NOT CONFIGURED');
 assert.equal(record.gates.find(g=>g.gate==='Production API health').status,'NOT CONFIGURED');
 for(const id of POLICY_IDS)assert.equal(record.gates.find(g=>g.gate==='Approved policy: '+id).status,'NOT CONFIGURED');
 assert.ok(record.gates.some(g=>g.status==='MANUAL ACTION REQUIRED'));
});
