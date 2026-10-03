import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import pg from 'pg';
import express from 'express';
import { createSaasService } from '../src/saas/service.mjs';
import { registerSaasRoutes } from '../src/saas/routes.mjs';
import { createSessionJobs, sessionSource, jobProgress, projectFromJob } from '../src/saas/jobs.mjs';
const plan={projectName:'Fixture',bpm:120,totalBars:2,sigNum:4,sigDen:4,tracks:[{id:'bass',name:'Bass',role:'bass',mode:'midi',vst:{name:'Fixture instrument',path:'C:/fixture.vst3'},midiRegions:[{startBar:1,lengthBars:1,repeatCount:2,notes:[{pitch:40,startBars:0,lengthBars:0.5,velocity:100}]}]},{id:'voice',name:'Voice',mode:'audio',useLyrics:true,renderInstructions:'Isolated vocal'}]};
const body={requestKey:'fixture-request',quantity:1,prompt:'Original prompt',lyrics:'Original lyrics',plan};
test('approved source validation limits MIDI, duration, IDs and rejects client artifacts',()=>{
  const s=sessionSource(body);assert.equal(s.seed,sessionSource(body).seed);assert.equal(s.plan.tracks[0].vst.path,'C:/fixture.vst3');
  for(const change of [{bpm:0},{totalBars:999999},{tracks:[...plan.tracks,plan.tracks[0]]},{tracks:[{...plan.tracks[0],objectKey:'foreign'}]},{tracks:[{...plan.tracks[0],midiRegions:[{startBar:1,lengthBars:1,repeatCount:3,notes:[]}]}]}])assert.throws(()=>sessionSource({...body,plan:{...plan,...change}}));
});
test('progress counts saved work and finalization, never elapsed time or failed parts',()=>{
  assert.equal(jobProgress({parts:{a:{state:'ready'},b:{state:'submitted'}}}).percent,33);
  assert.equal(jobProgress({saved:true,parts:{a:{state:'ready'},b:{state:'ambiguous'}}}).percent,66);
  assert.equal(jobProgress({saved:true,parts:{a:{state:'ready'},b:{state:'ready'}}}).percent,100);
});
test('editable project preserves independent identities, repeated MIDI, VST assignment and E',()=>{
  const v={id:'version',batch_id:'batch',version_index:2,created_at:new Date().toISOString()};
  const p=projectFromJob(v,sessionSource(body),{parts:{bass:{state:'ready'},voice:{state:'ready',objectKey:'owned/audio.wav'}}});
  assert.equal(p.clips.length,3);assert.equal(p.clips[1].startBar,2);assert.equal(p.endBar,3);assert.equal(p.tracks[0].vst3PluginPath,'C:/fixture.vst3');assert.equal(p.projectAssets[0].objectKey,'owned/audio.wav');assert.equal(p.generation.generationId,'version');
});
test('durable server batch lifecycle on isolated PostgreSQL with mocked paid providers',{skip:!process.env.TEST_SAAS_DATABASE_URL},async t=>{
  const url=new URL(process.env.TEST_SAAS_DATABASE_URL);
  if(!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/ysong_saas_validation')throw new Error('Dedicated local validation database required');
  const schema=`jobs_${crypto.randomUUID().replaceAll('-','')}`,root=new pg.Pool({connectionString:url.href});
  await root.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({connectionString:url.href,options:`-c search_path=${schema}`,max:10});
  t.after(async()=>{await pool.end();await root.end();});
  await pool.query('CREATE TABLE users(id uuid PRIMARY KEY,email text); CREATE TABLE user_client_state(user_id uuid PRIMARY KEY REFERENCES users(id),state jsonb NOT NULL DEFAULT \'{}\',updated_at timestamptz DEFAULT now())');
  const user=crypto.randomUUID(),other=crypto.randomUUID();
  await pool.query('INSERT INTO users VALUES($1,$2),($3,$4)',[user,'fixture@example.invalid',other,'other@example.invalid']);
  await pool.query(await fs.readFile(new URL('../src/saas/schema.sql',import.meta.url),'utf8'));
  await pool.query("UPDATE ysong_plans SET monthly_generation_quota=20,capabilities='{\"generation\":true}' WHERE id='free'");
  const service=createSaasService(pool);let calls=0,fail=false;
  const deps={pool,service,enabled:()=>true,provider:()=>({provider:'cloudflare',model:'minimax/music-2.6'}),
    generate:async(_provider,request)=>{calls++;if(fail===true||(typeof fail==='function'&&fail(request)))throw new Error('timeout');return {audio:Buffer.from('mock audio'),contentType:'audio/wav'};},persist:async(u,id)=>`user-uploads/${u}/${id}.wav`};
  let jobs=createSessionJobs(deps);
  const app=express();app.use(express.json());jobs.register(app,(req,_res,next)=>{req.user={id:req.headers['x-fixture-user']??user};next();});
  registerSaasRoutes(app,{pool,service,enabled:()=>true,requireAuth:(req,_res,next)=>{req.user={id:req.headers['x-fixture-user']??user,issuedAt:Math.floor(Date.now()/1000)+2};next();}});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const post=async(path,data,uid=user)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:'POST',headers:{'Content-Type':'application/json','x-fixture-user':uid},body:JSON.stringify(data)});return {status:r.status,data:await r.json()};};
  const get=async(path,uid=user)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{headers:{'x-fixture-user':uid}});return {status:r.status,data:await r.json()};};
  let batch;
  await t.test('quantity atomically reserves independent children and replays same identities',async()=>{
    const r=await post('/api/generations/batches',{...body,quantity:4});assert.equal(r.status,202);batch=r.data;
    assert.equal(new Set(batch.versions.map(v=>v.id)).size,4);assert.equal(new Set(batch.versions.map(v=>v.project_id)).size,4);
    assert.equal((await service.summary(user)).reserved,4);
    const replay=await post('/api/generations/batches',{...body,quantity:4});assert.equal(replay.status,200);assert.deepEqual(replay.data.versions.map(v=>v.id),batch.versions.map(v=>v.id));
    assert.equal((await post('/api/generations/batches',{...body,quantity:3})).status,409);
    assert.equal((await post('/api/generations/batches',{...body,requestKey:'bad-quantity',quantity:21})).status,400);
  });
  await t.test('execution survives page closure and fresh executor; concurrent workers do not duplicate paid calls',async()=>{
    jobs=createSessionJobs(deps);const competing=createSessionJobs(deps);
    for(let i=0;i<5;i++)await Promise.all([jobs.tick(),competing.tick()]);
    assert.equal(calls,4);assert.equal((await service.summary(user)).used,4);assert.equal((await service.summary(user)).reserved,0);
    for(const v of batch.versions){const r=await get(`/api/generations/${v.id}/project`);assert.equal(r.status,200);assert.equal(r.data.projectId,v.project_id);assert.equal(r.data.project.tracks.length,2);assert.equal(r.data.project.clips.length,3);}
    assert.equal((await get(`/api/generations/${batch.versions[0].id}/project`,other)).status,409);
  });
  await t.test('partial success retains MIDI, charges once, blocks ambiguous paid retry',async()=>{
    fail=true;const r=await post('/api/generations/batches',{...body,requestKey:'partial-batch'});await jobs.tick();
    const v=(await pool.query('SELECT * FROM ysong_generation_versions WHERE id=$1',[r.data.versions[0].id])).rows[0];
    assert.equal(v.state,'partially_ready');assert.equal(v.reconciliation,'consumed');assert.equal(v.execution.parts.voice.state,'ambiguous');assert.equal(jobProgress(v.execution).percent,66);
    const previous=calls;assert.equal((await post(`/api/generations/${v.id}/retry`,{})).status,409);await jobs.tick();assert.equal(calls,previous);
  });
  await t.test('restart during submission never reruns the uncertain render',async()=>{
    const r=await post('/api/generations/batches',{...body,requestKey:'restart-batch'});const v=r.data.versions[0];
    await pool.query("UPDATE ysong_generation_versions SET state='generating',execution=$2 WHERE id=$1",[v.id,{parts:{bass:{state:'ready'},voice:{state:'submitted'}}}]);
    const previous=calls;await createSessionJobs(deps).tick();assert.equal(calls,previous);
    assert.equal((await pool.query('SELECT state FROM ysong_generation_versions WHERE id=$1',[v.id])).rows[0].state,'partially_ready');
  });
  await t.test('safe pre-submission failure refunds and retry reserves once; partial component retry never double charges',async()=>{
    fail=false;await pool.query("UPDATE ysong_provider_controls SET enabled=false WHERE id='global'");
    const r=await post('/api/generations/batches',{...body,requestKey:'safe-failure'});await jobs.tick();const id=r.data.versions[0].id;
    assert.equal((await pool.query('SELECT reconciliation FROM ysong_generation_versions WHERE id=$1',[id])).rows[0].reconciliation,'released');
    await pool.query("UPDATE ysong_provider_controls SET enabled=true WHERE id='global'");
    const used=(await service.summary(user)).used;assert.equal((await post(`/api/generations/${id}/retry`,{})).status,202);
    assert.equal((await post(`/api/generations/${id}/retry`,{})).status,409);await jobs.tick();assert.equal((await service.summary(user)).used,used+1);
    const rr=await post('/api/generations/batches',{...body,requestKey:'safe-partial'});const vid=rr.data.versions[0].id;
    await pool.query('UPDATE ysong_generation_versions SET execution=$2 WHERE id=$1',[vid,{parts:{bass:{state:'ready'},voice:{state:'failed',error:'generation_unavailable_before_submission'}}}]);await jobs.tick();
    const saved=(await get(`/api/generations/${vid}/project`)).data;
    saved.project.tracks[0].name='User edited Bass';saved.project.clips[0].startBar=1.25;
    await pool.query('UPDATE user_client_state SET state=jsonb_set(state,ARRAY[$2],to_jsonb($3::text)) WHERE user_id=$1',[user,`ysong:daw:${saved.projectId}`,JSON.stringify(saved.project)]);
    const before=(await service.summary(user)).used;assert.equal((await post(`/api/generations/${vid}/retry`,{})).status,202);await jobs.tick();assert.equal((await service.summary(user)).used,before);
    assert.equal((await get(`/api/generations/${vid}/project`)).data.project.clips.length,3);
    assert.equal((await get(`/api/generations/${vid}/project`)).data.project.tracks[0].name,'User edited Bass');
    assert.equal((await get(`/api/generations/${vid}/project`)).data.project.clips[0].startBar,1.25);
  });
  await t.test('variation is immutable with owner-checked parent and independent projects',async()=>{
    const parent=batch.versions[0].id;const r=await post('/api/generations/batches',{...body,requestKey:'variation-batch',parentId:parent});
    assert.equal(r.status,202);assert.equal(r.data.batch.parent_generation_id,parent);assert.notEqual(r.data.versions[0].project_id,batch.versions[0].project_id);
    assert.equal(r.data.batch.source.lineageRootId,parent);assert.equal(r.data.batch.source.lineageVersion,2);
    assert.equal((await post('/api/generations/batches',{...body,requestKey:'foreign-variation',parentId:parent},other)).status,404);
    await jobs.tick();
  });
  await t.test('project-save failure keeps durable audio and reservation; finalization retry makes no paid call',async()=>{
    fail=false;const r=await post('/api/generations/batches',{...body,requestKey:'save-failure'});const id=r.data.versions[0].id;
    const bad=createSessionJobs({...deps,service:{...service,transaction:async()=>{throw new Error('fixture storage outage');}}});
    await bad.tick();const v=(await pool.query('SELECT * FROM ysong_generation_versions WHERE id=$1',[id])).rows[0];
    assert.equal(v.state,'failed');assert.equal(v.reconciliation,'reserved');assert.equal(v.execution.parts.voice.state,'ready');assert.ok(jobProgress(v.execution).percent<100);
    const before=calls;assert.equal((await post(`/api/generations/${id}/retry-finalization`,{})).status,202);await jobs.tick();assert.equal(calls,before);
    assert.equal((await get(`/api/generations/${id}/project`)).status,200);
  });
  await t.test('mixed child outcomes charge usable versions once and history retains exact sources',async()=>{
    fail=request=>request.seed%2===0;const used=(await service.summary(user)).used;
    const r=await post('/api/generations/batches',{...body,quantity:4,requestKey:'mixed-batch'});
    for(let i=0;i<4;i++)await jobs.tick();
    const rows=(await pool.query('SELECT * FROM ysong_generation_versions WHERE batch_id=$1',[r.data.batch.id])).rows;
    assert.equal(rows.filter(v=>v.state==='ready').length,2);assert.equal(rows.filter(v=>v.state==='partially_ready').length,2);assert.equal((await service.summary(user)).used,used+4);
    const history=(await get('/api/generations/history')).data.generations.filter(v=>v.batch_id===r.data.batch.id);
    assert.equal(history.length,4);assert.equal(history[0].source.lyrics,'Original lyrics');assert.equal(history[0].source.plan.tracks[0].vst.path,'C:/fixture.vst3');
  });
  await t.test('queued cancellation releases once and cannot execute or alter consumed quota',async()=>{
    const r=await post('/api/generations/batches',{...body,requestKey:'cancel-batch'});const id=r.data.versions[0].id;const before=(await service.summary(user));
    assert.equal((await post(`/api/generations/${id}/cancel`,{})).status,200);assert.equal((await post(`/api/generations/${id}/cancel`,{})).status,200);
    const paid=calls;await jobs.tick();assert.equal(calls,paid);assert.equal((await service.summary(user)).reserved,before.reserved-1);assert.equal((await service.summary(user)).used,before.used);
  });
  await t.test('new authenticated sessions and jobs remain usable after revoking older sessions',async()=>{
    await pool.query("UPDATE ysong_account_access SET sessions_revoked_before=now()-interval '1 second' WHERE user_id=$1",[user]);
    await assert.rejects(service.summary(user,Math.floor(Date.now()/1000)-10),/session_revoked/);
    assert.ok((await get('/api/account/entitlements')).data.enabled);
    fail=false;const r=await post('/api/generations/batches',{...body,requestKey:'new-session-batch'});await jobs.tick();
    assert.equal((await get(`/api/generations/${r.data.versions[0].id}/project`)).status,200);
  });
  await t.test('temporary database connection failure does not permanently stall the executor',async()=>{
    let offline=true;
    const flaky=new Proxy(pool,{get(target,key){if(key==='connect')return async()=>{if(offline){offline=false;throw new Error('fixture offline');}return target.connect();};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
    const worker=createSessionJobs({...deps,pool:flaky});
    await assert.rejects(worker.tick(),/fixture offline/);
    const r=await post('/api/generations/batches',{...body,requestKey:'database-recovery'});await worker.tick();
    assert.equal((await get(`/api/generations/${r.data.versions[0].id}/project`)).status,200);
  });
});
