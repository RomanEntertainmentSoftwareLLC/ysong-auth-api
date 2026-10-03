// Read-only production evidence. No Stripe, email, generator, or catalog writes.
import pg from 'pg';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {S3Client,ListObjectsV2Command} from '@aws-sdk/client-s3';
import {environmentGates,catalogGates,legalGates,readiness} from '../src/saas/preflight.mjs';

const env=process.env,remote=process.argv.includes('--remote'),gates=environmentGates(env);
const report=(gate,status,detail)=>gates.push({gate,status,detail});
const run=promisify(execFile),root=fileURLToPath(new URL('../',import.meta.url));
const safe='safe.directory='+root.replaceAll('\\','/').replace(/\/$/,'');
try{
 const {stdout:status}=await run('git',['-c',safe,'status','--porcelain'],{cwd:root,windowsHide:true,timeout:10000});
 report('Local Git working tree',status.trim()?'MANUAL ACTION REQUIRED':'PASS','Release revision still requires approval');
 const {stdout:tracked}=await run('git',['-c',safe,'ls-files','-z'],{cwd:root,windowsHide:true,timeout:10000,maxBuffer:5_000_000});
 const secrets=Object.entries(env).filter(([k,v])=>/SECRET|TOKEN|API_KEY|ACCESS_KEY|DATABASE_URL/.test(k)&&typeof v==='string'&&v.length>=12).map(([,v])=>v);
 let found=false;
 for(const file of tracked.split('\0').filter(Boolean)){
  if(/(^|\/)\.env($|\.)/.test(file)&&!file.endsWith('.example')){found=true;continue;}
  const path=new URL(file,new URL('../',import.meta.url)),stat=await fs.stat(path).catch(()=>null);
  if(!stat||!stat.isFile()||stat.size>2_000_000)continue;
  const content=await fs.readFile(path,'utf8').catch(()=>null);
  if(content&&secrets.some(secret=>content.includes(secret)))found=true;
 }
 report('Tracked known credentials',found?'FAIL':'PASS','Local tracked files only; no values printed');
}catch{report('Local Git audit','MANUAL ACTION REQUIRED','Local audit unavailable');}
try{
 const files=await fs.readdir(new URL('../.github/workflows/',import.meta.url));
 let unsafe=false;
 for(const file of files.filter(f=>/\.ya?ml$/.test(f))){
  const content=await fs.readFile(new URL('../.github/workflows/'+file,import.meta.url),'utf8');
  if(/VM_SSH_KEY|rsync|systemctl|gcloud|\bssh\b/.test(content))unsafe=true;
 }
 report('Retired deployment workflows',unsafe?'FAIL':'PASS','Local workflow source only');
}catch{report('Retired deployment workflows','MANUAL ACTION REQUIRED','Workflow audit unavailable');}

const tables=['ysong_plans','ysong_account_access','ysong_saas_bootstrap','ysong_quota_periods','ysong_generation_batches','ysong_generation_versions','ysong_billing_events','ysong_admin_audit','ysong_usage_events','ysong_policy_versions','ysong_policy_acceptances','ysong_content_reviews','ysong_takedown_cases','ysong_checkout_attempts','ysong_billing_failures','ysong_notifications','ysong_saas_migrations'];
if(!env.DATABASE_URL)report('Neon/read-only database connection','NOT CONFIGURED','DATABASE_URL absent');
else{
 const pool=new pg.Pool({connectionString:env.DATABASE_URL,connectionTimeoutMillis:10000,max:1,ssl:env.PGSSL==='0'?false:{rejectUnauthorized:false}});
 let client;
 try{
  client=await pool.connect();
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout = '10s'");
  report('Neon/read-only database connection','PASS','Read-only transaction');
  const rows=(await client.query('SELECT name,to_regclass(name) IS NOT NULL AS present FROM unnest($1::text[]) AS name',[tables])).rows;
  const present=name=>rows.some(r=>r.name===name&&r.present);
  report('SaaS tables',rows.every(r=>r.present)?'PASS':'NOT CONFIGURED','Missing: '+(rows.filter(r=>!r.present).map(r=>r.name).join(', ')||'none'));
  if(present('ysong_saas_migrations')){
   const markers=(await client.query("SELECT id FROM ysong_saas_migrations WHERE id IN ('launch-preparation-v1','guarded-migration-v2')")).rows;
   report('Additive migration markers',markers.length===2?'PASS':'NOT CONFIGURED','Required markers present: '+markers.length+'/2');
  }else report('Additive migration markers','NOT CONFIGURED','Migration table absent');
  gates.push(...catalogGates(present('ysong_plans')?(await client.query('SELECT * FROM ysong_plans')).rows:[]));
  if(present('ysong_account_access')&&present('ysong_saas_bootstrap')){
   const count=(await client.query("SELECT count(*)::int AS n FROM ysong_saas_bootstrap b JOIN ysong_account_access a ON a.user_id=b.user_id WHERE b.id='superadmin' AND a.role='superadmin' AND a.account_status='active'")).rows[0].n;
   const roles=(await client.query("SELECT count(*)::int AS n FROM ysong_account_access WHERE role='superadmin'")).rows[0].n;
   report('Immutable superadmin identity',count===1&&roles===1?'PASS':'FAIL','Bootstrap UUID and active role must match exactly once');
  }else report('Immutable superadmin identity','NOT CONFIGURED','Bootstrap/access table absent');
  const policies=present('ysong_policy_versions')?(await client.query('SELECT * FROM ysong_policy_versions WHERE active')).rows:[];
  gates.push(...legalGates(policies));
  report('Critical notification storage',present('ysong_notifications')?'PASS':'NOT CONFIGURED','Inbox table presence only');
  report('Generation/recovery storage',['ysong_generation_batches','ysong_generation_versions','ysong_quota_periods','ysong_admin_audit','ysong_billing_failures'].every(present)?'PASS':'NOT CONFIGURED','Runtime walkthrough remains manual');
 }catch{report('Database launch audit','FAIL','Connection or schema query failed');}
 finally{if(client){await client.query('ROLLBACK').catch(()=>{});client.release();}await pool.end();}
}

// Keep every database domain visible even when the connection fails early.
for(const legal of legalGates([]))if(!gates.some(g=>g.gate===legal.gate))gates.push(legal);
for(const gate of ['SaaS tables','Additive migration markers','Immutable superadmin identity','Critical notification storage','Generation/recovery storage',...catalogGates([]).map(g=>g.gate)])
 if(!gates.some(g=>g.gate===gate))report(gate,'NOT CONFIGURED','Database evidence unavailable');

async function get(gate,url,check){
 try{const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(10000)});report(gate,check(response)?'PASS':'FAIL','Read-only public GET');}
 catch{report(gate,'FAIL','Read-only request unavailable');}
}
if(remote){
 await get('Production API health','https://api.ysong.ai/healthz',r=>r.ok);
 await get('Production database health','https://api.ysong.ai/healthz/db',r=>r.ok);
 try{const r=await fetch('https://api.ysong.ai/healthz',{headers:{Origin:'https://www.ysong.ai'},redirect:'manual',signal:AbortSignal.timeout(10000)});report('Production CORS',r.ok&&r.headers.get('access-control-allow-origin')==='https://www.ysong.ai'?'PASS':'FAIL','Allowed frontend origin');}
 catch{report('Production CORS','FAIL','Read-only request unavailable');}
 if(['R2_ENDPOINT','R2_BUCKET','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY'].every(k=>env[k])){
  const s3=new S3Client({region:'auto',endpoint:env.R2_ENDPOINT,credentials:{accessKeyId:env.R2_ACCESS_KEY_ID,secretAccessKey:env.R2_SECRET_ACCESS_KEY},maxAttempts:1});
  try{await s3.send(new ListObjectsV2Command({Bucket:env.R2_BUCKET,MaxKeys:1}),{abortSignal:AbortSignal.timeout(10000)});report('Production R2 read','PASS','Metadata listing only');}
  catch{report('Production R2 read','FAIL','Metadata listing unavailable');}
  finally{s3.destroy();}
 }else report('Production R2 read','NOT CONFIGURED','R2 credentials absent');
 await get('Production frontend reachable','https://www.ysong.ai/login',r=>r.ok);
}else for(const gate of ['Production API health','Production database health','Production CORS','Production R2 read','Production frontend reachable'])report(gate,'NOT CONFIGURED','Run with --remote');
for(const gate of ['Deployed Worker bindings and revision','Frontend production API URL and SaaS revision','Stripe portal/Link/tax settings and live webhook delivery','Stripe sandbox lifecycle','Admin authorization and recovery walkthrough','Legal approval and DMCA delivery procedure','Public moderation/rights and cache handling','Generation reservation/recovery walkthrough','Critical inbox and Stripe receipt email settings','Full repository review and release approval'])report(gate,'MANUAL ACTION REQUIRED','Operator evidence required');
const status=readiness(gates);
console.log(JSON.stringify({status,scope:'Local configuration, target DATABASE_URL, optional public production reads; deployed bindings require review',gates}));
process.exitCode=status==='PASS'?0:1;
