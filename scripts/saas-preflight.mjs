import 'dotenv/config';
import pg from 'pg';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {S3Client,ListObjectsV2Command} from '@aws-sdk/client-s3';
import {environmentGates,catalogGates,readiness} from '../src/saas/preflight.mjs';
const env=process.env,gates=environmentGates(env),run=promisify(execFile);
const report=(gate,status,detail)=>gates.push({gate,status,detail});
const root=new URL('../',import.meta.url),web=new URL('../../ysong-web/ysong/',import.meta.url);
for(const [name,repo] of [['Auth',root],['Web',web]]){
 try{const cwd=fileURLToPath(repo),safe='safe.directory='+cwd.replaceAll('\\','/').replace(/\/$/,'');
  const {stdout:status}=await run('git',['-c',safe,'status','--porcelain'],{cwd,windowsHide:true});
  report(name+' Git review',status.trim()?'MANUAL ACTION REQUIRED':'PASS','Local status only; no fetch/commit/push');
  const {stdout:tracked}=await run('git',['-c',safe,'ls-files','-z'],{cwd,windowsHide:true});
  const secretValues=Object.entries(env).filter(([k,v])=>/SECRET|TOKEN|API_KEY|ACCESS_KEY|DATABASE_URL/.test(k)&&typeof v==='string'&&v.length>=12).map(([,v])=>v);
  let found=false;for(const file of tracked.split('\0').filter(Boolean)){if(/(^|\/)\.env($|\.)/.test(file)&&!file.endsWith('.example')){found=true;continue;}
   const u=new URL(file,repo),stat=await fs.stat(u).catch(()=>null);if(!stat||stat.size>2000000)continue;
   const text=await fs.readFile(u,'utf8').catch(()=>null);if(text&&secretValues.some(v=>text.includes(v)))found=true;}
  report(name+' tracked credential scan',found?'FAIL':'PASS','Known configured secrets and tracked env files only; no values printed; broader review remains required');
 }catch{report(name+' Git audit','MANUAL ACTION REQUIRED','Local audit unavailable');}
}
try{const files=await fs.readdir(new URL('.github/workflows/',root));let unsafe=false;
 for(const file of files.filter(f=>/\.ya?ml$/.test(f))){const text=await fs.readFile(new URL('.github/workflows/'+file,root),'utf8');if(/VM_SSH_KEY|rsync|systemctl|gcloud|\bssh\b/.test(text))unsafe=true;}
 report('Retired deployment workflows',unsafe?'FAIL':'PASS','All local auth workflows audited; future deployment remains manual');
}catch{report('Retired deployment workflows','FAIL','Cannot audit workflow directory');}
const tables=['ysong_plans','ysong_account_access','ysong_quota_periods','ysong_generation_batches','ysong_generation_versions','ysong_billing_events','ysong_admin_audit','ysong_usage_events','ysong_policy_versions','ysong_policy_acceptances','ysong_content_reviews','ysong_takedown_cases','ysong_checkout_attempts','ysong_billing_failures','ysong_notifications','ysong_saas_migrations'];
const pool=new pg.Pool({connectionString:env.TEST_SAAS_DATABASE_URL??env.DATABASE_URL,connectionTimeoutMillis:10000,ssl:env.TEST_SAAS_DATABASE_URL||env.PGSSL==='0'?false:{rejectUnauthorized:false}});
let client;
try{client=await pool.connect();await client.query('BEGIN READ ONLY');
 report('Neon/read-only database connection','PASS','SELECT checks only');
 const rows=(await client.query('SELECT name,to_regclass(name) IS NOT NULL AS present FROM unnest($1::text[]) AS name',[tables])).rows;
 const present=name=>rows.find(r=>r.name===name)?.present;
 report('SaaS tables',rows.every(r=>r.present)?'PASS':'NOT CONFIGURED','Missing: '+(rows.filter(r=>!r.present).map(r=>r.name).join(', ')||'none'));
 if(present('ysong_saas_migrations'))report('Latest additive migration',(await client.query("SELECT 1 FROM ysong_saas_migrations WHERE id='launch-preparation-v1'")).rows.length?'PASS':'NOT CONFIGURED','Explicit migration marker; no migration performed');
 else report('Latest additive migration','NOT CONFIGURED','Pending');
 gates.push(...catalogGates(present('ysong_plans')?(await client.query('SELECT * FROM ysong_plans')).rows:[]));
 if(present('ysong_account_access'))report('Immutable superadmin identity',(await client.query("SELECT 1 FROM ysong_account_access WHERE role='superadmin' AND account_status='active'")).rows.length===1?'PASS':'FAIL','Stored UUID/role, not email authorization');
 else report('Immutable superadmin identity','NOT CONFIGURED','Migration/bootstrap pending');
 const policies=present('ysong_policy_versions')?(await client.query('SELECT * FROM ysong_policy_versions WHERE active')).rows:[];
 for(const id of ['terms','privacy','upload-rights','billing','generated-output','bridge-license'])report('Approved policy: '+id,policies.some(p=>p.policy_id===id&&p.approved&&p.required&&p.approval_reference&&!/draft|placeholder|attorney.review.required/i.test(p.version))?'PASS':'NOT CONFIGURED','ATTORNEY REVIEW REQUIRED; no approval fabricated');
 report('Critical in-app notification storage',present('ysong_notifications')?'PASS':'NOT CONFIGURED','Existing inbox reused; email not implied');
 report('Recovery/audit storage',['ysong_admin_audit','ysong_billing_failures','ysong_generation_versions'].every(present)?'PASS':'NOT CONFIGURED','Runtime authorization/locking walkthrough still required');
}catch{report('Database launch audit','NOT CONFIGURED','Connection/schema unavailable; existing infrastructure migration not repeated');}
finally{if(client){await client.query('ROLLBACK').catch(()=>{});client.release();}await pool.end();}
for(const [gate,file,pattern] of [['Pricing source','src/pages/Pricing.tsx','/api/billing/catalog'],['Account/billing source','src/components/BillingAccount.tsx','/api/billing/portal'],['Usage source','src/components/AccountPlan.tsx','entitlement.remaining'],['Legal acceptance source','src/components/PolicyAcceptance.tsx','/api/account/policies'],['Recovery UI source','src/components/RecoveryAdmin.tsx','/api/admin/recovery']]){
 try{report(gate,(await fs.readFile(new URL(file,web),'utf8')).includes(pattern)?'PASS':'FAIL','Local source; deployed UI requires release verification');}catch{report(gate,'FAIL','Required local surface unavailable');}}
if(process.argv.includes('--remote')){
 for(const path of ['/healthz','/healthz/db']){try{const r=await fetch('https://api.ysong.ai'+path,{signal:AbortSignal.timeout(10000)});report('Production '+path,r.ok?'PASS':'FAIL','Read-only public health');}catch{report('Production '+path,'FAIL','Request unavailable');}}
 try{const r=await fetch('https://api.ysong.ai/healthz',{headers:{Origin:'https://www.ysong.ai'},signal:AbortSignal.timeout(10000)});report('Production CORS',r.headers.get('access-control-allow-origin')==='https://www.ysong.ai'?'PASS':'FAIL','Allowed frontend origin');}catch{report('Production CORS','FAIL','Request unavailable');}
 if(['R2_ENDPOINT','R2_BUCKET','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY'].every(k=>env[k])){const s3=new S3Client({region:'auto',endpoint:env.R2_ENDPOINT,credentials:{accessKeyId:env.R2_ACCESS_KEY_ID,secretAccessKey:env.R2_SECRET_ACCESS_KEY},maxAttempts:1});
  try{await s3.send(new ListObjectsV2Command({Bucket:env.R2_BUCKET,MaxKeys:1}),{abortSignal:AbortSignal.timeout(10000)});report('Production R2 read','PASS','Metadata listing only; no keys/data printed or changed');}catch{report('Production R2 read','MANUAL ACTION REQUIRED','Read unavailable or credential scope needs owner review');}finally{s3.destroy();}}
 try{const r=await fetch('https://www.ysong.ai/login',{signal:AbortSignal.timeout(10000)});report('Production frontend reachable',r.ok?'PASS':'FAIL','No sign-in/account mutation');}catch{report('Production frontend reachable','FAIL','Request unavailable');}
}
for(const gate of ['Deployed Worker secret/env bindings','Frontend production API URL and SaaS revision','Stripe portal features/Link/tax settings','Stripe sandbox subscription/webhook lifecycle','Admin authorization and recovery walkthrough','Legal approval and DMCA notice delivery procedure','Public moderation/rights and cache handling','Generation reservation/recovery walkthrough without paid calls','Critical notification inbox/Stripe receipt email settings','Full repository review and release approval'])report(gate,'MANUAL ACTION REQUIRED','Human/release evidence required; code/config presence is not approval');
console.log(JSON.stringify({readiness:readiness(gates),scope:'Local env/source and configured target DB; deployed runtime bindings require operator verification',gates},null,2));
process.exitCode=gates.some(g=>g.status!=='PASS')?1:0;
