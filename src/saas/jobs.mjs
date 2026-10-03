import crypto from 'node:crypto';
import {notifySaas} from './notifications.mjs';
import { AccessError, assertCapability, effectiveEntitlement, quantityOf } from './service.mjs';

const terminal = new Set(['ready','partially_ready','failed','cancelled']);
const uuid = /^[0-9a-f-]{36}$/i;
export function sessionSource(body) {
  const p = body?.plan;
  const finite = (n,min,max) => Number.isFinite(n) && n >= min && n <= max;
  if (!p || !finite(p.bpm,30,300) || !Number.isInteger(p.totalBars) || !finite(p.totalBars,1,1024) ||
      !Number.isInteger(p.sigNum) || !finite(p.sigNum,1,16) || ![1,2,4,8,16].includes(p.sigDen) ||
      typeof p.projectName !== 'string' || p.projectName.length > 200 || !Array.isArray(p.tracks) || !p.tracks.length || p.tracks.length > 32)
    throw new AccessError('invalid_session_plan',400);
  let events = 0;
  const ids = new Set();
  for (const t of p.tracks) {
    if (!t || typeof t.id !== 'string' || !/^[\w-]{1,80}$/.test(t.id) || ids.has(t.id) ||
        !['midi','audio'].includes(t.mode) || typeof t.name !== 'string' || t.name.length > 200 ||
        (t.mode === 'audio' && (typeof t.renderInstructions !== 'string' || !t.renderInstructions.trim() || t.renderInstructions.length > 80000)))
      throw new AccessError('invalid_session_track',400);
    ids.add(t.id);
    if (t.objectKey || t.durationSec) throw new AccessError('client_artifact_not_allowed',400);
    if (t.mode === 'midi') {
      if (!Array.isArray(t.midiRegions) || !t.midiRegions.length || t.midiRegions.length > 256) throw new AccessError('invalid_midi',400);
      for (const r of t.midiRegions) {
        if (!finite(r.startBar,1,p.totalBars) || !finite(r.lengthBars,1/128,p.totalBars) || !Number.isInteger(r.repeatCount) || !finite(r.repeatCount,1,1024) ||
            r.startBar - 1 + r.lengthBars * r.repeatCount > p.totalBars + 0.001 || !Array.isArray(r.notes)) throw new AccessError('invalid_midi',400);
        events += r.notes.length * r.repeatCount;
        for (const n of r.notes) if (!Number.isInteger(n.pitch) || !finite(n.pitch,0,127) || !finite(n.startBars,0,r.lengthBars) || !finite(n.lengthBars,1/128,r.lengthBars-n.startBars) || !finite(n.velocity,1,127)) throw new AccessError('invalid_midi',400);
      }
      if (!t.midiRegions.some(r=>r.notes.length)) throw new AccessError('empty_midi_track',400);
    }
  }
  if (events > 100000 || p.totalBars * p.sigNum * (4/p.sigDen) * 60/p.bpm > 600) throw new AccessError('session_too_large',400);
  if (typeof body.lyrics !== 'string' || body.lyrics.length > 120000 || typeof body.prompt !== 'string' || body.prompt.length > 80000) throw new AccessError('invalid_generation_source',400);
  const source = { kind:'session', plan:p, lyrics:body.lyrics, prompt:body.prompt, seed:crypto.randomInt(2000000000), configVersion:1 };
  if (JSON.stringify(source).length > 200000) throw new AccessError('invalid_generation_source',400);
  // Seed must be stable across a replay; derive it from the request identity rather than fresh randomness.
  source.seed = crypto.createHash('sha256').update(String(body.requestKey)).digest().readUInt32BE(0) % 2000000000;
  return source;
}
export function jobProgress(execution) {
  const parts = Object.values(execution?.parts ?? {});
  const completed = parts.filter(p => p.state === 'ready').length;
  return { completed, total:parts.length + 1, percent:Math.floor(100 * (completed + (execution?.saved ? 1 : 0)) / (parts.length + 1)),
    message:execution?.message ?? 'Queued', reviewRequired:parts.some(p => p.state === 'ambiguous') };
}
export function projectFromJob(version, source, execution) {
  const p = source.plan, tracks = [], clips = [], projectAssets = [];
  for (const t of p.tracks) {
    const id = `${version.id}-${t.id}`, part = execution.parts[t.id];
    tracks.push({ id, type:t.mode === 'audio'?'audio':'instrument', name:t.name, mute:false,solo:false,arm:false,level:100,
      gmProgram:t.gmProgram, vst3PluginPath:t.vst?.path, vst3PluginName:t.vst?.name, vst3PluginVendor:t.vst?.vendor,
      vstPresetHint:t.presetHint ?? t.vst?.presetHint, instrumentIntent:t.instrumentIntent, desiredInstrument:t.desiredInstrument, instrumentResolution:t.instrumentResolution });
    if (part.state !== 'ready') continue;
    if (t.mode === 'audio') {
      const assetId = `${id}-audio`;
      projectAssets.push({ id:assetId,kind:'audio',name:t.name,objectKey:part.objectKey });
      clips.push({id:`${id}-clip`,trackId:id,name:t.name,composerRole:t.role,startBar:1,lengthBars:p.totalBars,assetId,sourceOffsetSec:0});
    } else for (const [ri,r] of t.midiRegions.entries()) for (let repeat=0; repeat<r.repeatCount; repeat++) {
      clips.push({id:`${id}-${ri}-${repeat}`,trackId:id,name:t.name,startBar:r.startBar+repeat*r.lengthBars,lengthBars:r.lengthBars,
        composerRole:t.role,midiNotes:r.notes.map((n,ni)=>({...n,id:`${id}-${ri}-${repeat}-${ni}`}))});
    }
  }
  const generation = { origin:'create-song',sessionId:version.id,generationId:version.id,batchId:version.batch_id,versionIndex:version.version_index,
    createdAt:new Date(version.created_at).getTime(),title:p.projectName,provider:version.provider,model:version.model,source,singerRoster:p.singerRoster };
  return { v:1,generation,tracks,clips,projectAssets,selectedTrackId:tracks[0]?.id??null,selectedClipId:null,
    snapEnabled:true,gridValue:'bar',gridMode:'absolute',playheadPosBars:1,loopL:1,loopR:p.totalBars+1,endBar:p.totalBars+1,endMarkerMode:'auto',loopEnabled:false,
    bpm:p.bpm,sigNum:p.sigNum,sigDen:p.sigDen,masterLevel:100 };
}
export function createSessionJobs({pool,service,enabled,provider,generate,persist,inspectArtifact}) {
  let running = false;
  async function save(v, execution, state) {
    await pool.query('UPDATE ysong_generation_versions SET execution=$2,state=$3,updated_at=now() WHERE id=$1',[v.id,execution,state]);
    // Notification failure must never invalidate a persisted render checkpoint.
    if(state==='failed')await notifySaas(pool,v.user_id,`generation:${v.id}:attention`,'Generation needs attention',execution.message||'Review the saved generation state before retrying.','/app?view=createSong').catch(()=>{});
  }
  async function execute(v, source) {
    let e = v.execution ?? { parts:Object.fromEntries(source.plan.tracks.map(t=>[t.id,{state:'queued'}])), saved:false };
    // An interrupted submission/storage boundary is ambiguous. Do not replay paid work.
    for (const part of Object.values(e.parts)) if (['submitted','processing'].includes(part.state)) part.state='ambiguous';
    const config = v.provider ? {provider:v.provider,model:v.model} : provider();
    await pool.query('UPDATE ysong_generation_versions SET provider=$2,model=$3,model_version=$4 WHERE id=$1',[v.id,config.provider,config.model,'session-v1']);
    v = {...v,...config};
    for (const t of source.plan.tracks) {
      if (!enabled()) return;
      const part = e.parts[t.id];
      if (part.state !== 'queued') continue;
      try { assertCapability(await service.access(v.user_id,new Date(v.created_at).getTime()/1000),'generation'); await service.providerEnabled(config.provider);
        const current=provider();if(config.provider!==current.provider||config.model!==current.model)throw new Error('provider_configuration_changed'); }
      catch { part.state='failed'; part.error='generation_unavailable_before_submission'; continue; }
      e.message = `${t.mode === 'midi'?'Saving MIDI':'Rendering'} ${t.name}`;
      if (t.mode === 'midi') { part.state='ready'; await save(v,e,'generating'); continue; }
      part.request={instructions:t.renderInstructions,lyrics:t.useLyrics?source.lyrics:'[Instrumental]',seed:(source.seed+v.version_index)%2000000000,
        durationSeconds:source.plan.totalBars*source.plan.sigNum*(4/source.plan.sigDen)*60/source.plan.bpm,maxNewTokens:9000,quality:'standard'};
      part.state='submitted'; await save(v,e,'generating');
      try {
        const audio = await generate(config.provider,part.request);
        if (!Buffer.isBuffer(audio.audio) || !audio.audio.length) throw new Error('empty_audio');
        part.state='processing'; await save(v,e,'processing');
        part.objectKey = await persist(v.user_id,`${v.id}-${t.id}`,audio);
        part.hash = crypto.createHash('sha256').update(audio.audio).digest('hex');
        part.contentType=audio.contentType; part.bytes=audio.audio.length; part.state='ready';
      } catch { part.state='ambiguous'; part.error='provider_or_storage_outcome_requires_review'; }
      await save(v,e,'generating');
    }
    const usable = Object.values(e.parts).some(p=>p.state==='ready');
    const uncertain = Object.values(e.parts).some(p=>p.state==='ambiguous');
    if (!usable) {
      e.message = uncertain?'Provider outcome requires review; reservation retained':'Generation failed before submission';
      await save(v,e,'failed');
      if (!uncertain) await service.reconcile(v.id,'failed',null,'generation_unavailable');
      return;
    }
    e.message='Saving editable project'; await save(v,e,'finalizing');
    const project = projectFromJob(v,source,e);
    try { await service.transaction(async c=>{
      await c.query("INSERT INTO user_client_state(user_id,state) VALUES($1,'{}') ON CONFLICT DO NOTHING",[v.user_id]);
      const row=(await c.query('SELECT state FROM user_client_state WHERE user_id=$1 FOR UPDATE',[v.user_id])).rows[0];
      const state = row.state;
      // Preserve existing project edits; retries never replace an already saved editable project.
      const key=`ysong:daw:${v.project_id}`;
      if (!state[key]) {
        const catalog=JSON.parse(state['ysong:projects:v1']??'[]');
        state[key]=JSON.stringify(project); state[`ysong:projectName:${v.project_id}`]=source.plan.projectName;
        state['ysong:projects:v1']=JSON.stringify([...catalog.filter(p=>p.id!==v.project_id),{id:v.project_id,name:source.plan.projectName,updatedAt:Date.now(),generation:project.generation}]);
        await c.query('UPDATE user_client_state SET state=$2,updated_at=now() WHERE user_id=$1',[v.user_id,state]);
      } else {
        const saved=JSON.parse(state[key]);
        // Retry only adds newly available clips/assets. User edits and existing sources survive.
        const priorReady=v.result?.parts??{};
        const newIds=new Set(source.plan.tracks.filter(t=>e.parts[t.id].state==='ready'&&priorReady[t.id]?.state!=='ready').map(t=>`${v.id}-${t.id}`));
        saved.clips.push(...project.clips.filter(clip=>newIds.has(clip.trackId)&&!saved.clips.some(old=>old.id===clip.id)));
        saved.projectAssets.push(...project.projectAssets.filter(asset=>!saved.projectAssets.some(old=>old.id===asset.id)));
        state[key]=JSON.stringify(saved);
        await c.query('UPDATE user_client_state SET state=$2,updated_at=now() WHERE user_id=$1',[v.user_id,state]);
      }
    }); } catch {
      e.message='Project save failed; durable parts retained. Retry saving without a provider call.';
      await save(v,e,'failed');return;
    }
    const outcome=Object.values(e.parts).every(p=>p.state==='ready')?'ready':'partially_ready';
    e.saved=true; e.message=outcome==='ready'?'Ready':'Partial project saved; review failed parts';
    // A durable project must exist before quota is consumed and 100% is reported.
    await service.reconcile(v.id,outcome,{projectId:v.project_id,parts:e.parts},uncertain?'provider_outcome_requires_review':null,e);
  }
  async function tick() {
    if (running || !enabled()) return;
    running=true;
    let c;
    let lockedId;
    try {
      c=await pool.connect();
      const candidates=(await c.query(`SELECT v.*,b.source FROM ysong_generation_versions v JOIN ysong_generation_batches b ON b.id=v.batch_id
        WHERE b.source->>'kind'='session' AND v.state IN ('queued','planning','generating','processing','finalizing') ORDER BY v.created_at LIMIT 40`)).rows;
      for (const candidate of candidates) {
        if (!(await c.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[candidate.id])).rows[0].locked) continue;
        lockedId=candidate.id;
        // Re-read after acquiring lock: another process may already have finished/cancelled it.
        const v=(await c.query('SELECT * FROM ysong_generation_versions WHERE id=$1',[lockedId])).rows[0];
        if (!terminal.has(v.state)) {
          if (v.state === 'queued') {
            const claimed=await c.query("UPDATE ysong_generation_versions SET state='planning',updated_at=now() WHERE id=$1 AND state='queued' RETURNING id",[v.id]);
            if (claimed.rows.length) await execute(v,candidate.source);
          } else await execute(v,candidate.source);
        }
        await c.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lockedId]); lockedId=null;
        break;
      }
    } finally {
      try { if (c&&lockedId) await c.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lockedId]); }
      finally { c?.release(); running=false; }
    }
  }
  function start() { const timer=setInterval(()=>{void tick().catch(()=>{});},2000);timer.unref();return()=>clearInterval(timer); }
  function register(app,requireAuth) {
    const wrap=fn=>async(req,res)=>{if(!enabled())return res.status(503).json({error:'saas_not_enabled'});try{await fn(req,res);}catch(e){res.status(e instanceof AccessError?e.status:503).json({error:e instanceof AccessError?e.code:'generation_service_unavailable'});}};
    app.get('/api/admin/generations/uncertain',requireAuth,wrap(async(req,res)=>{
      const a=await service.account(pool,req.user.id);if(a?.account_status!=='active'||!['admin','superadmin'].includes(a.role))throw new AccessError('admin_required');
      res.json({generations:(await pool.query("SELECT * FROM ysong_generation_versions WHERE execution IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_each(execution->'parts') p WHERE p.value->>'state'='ambiguous') ORDER BY created_at LIMIT 100")).rows});
    }));
    app.post('/api/admin/generations/:id/parts/:part/resolve',requireAuth,wrap(async(req,res)=>{
      if(!uuid.test(req.params.id)||typeof req.body?.reason!=='string'||req.body.reason.trim().length<10||req.body.reason.length>2000||!['confirmed_success','confirmed_failure'].includes(req.body.outcome))throw new AccessError('invalid_resolution',400);
      if(req.body.outcome==='confirmed_failure'&&(typeof req.body.providerReference!=='string'||req.body.providerReference.trim().length<3))throw new AccessError('failure_evidence_reference_required',400);
      const result=await service.transaction(async c=>{
        const a=await service.account(c,req.user.id,true);if(a?.account_status!=='active'||!['admin','superadmin'].includes(a.role))throw new AccessError('admin_required');
        if(!(await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',[req.params.id])).rows[0].locked)throw new AccessError('render_executor_active',409);
        const v=(await c.query('SELECT * FROM ysong_generation_versions WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
        const batch=v?(await c.query('SELECT * FROM ysong_generation_batches WHERE id=$1',[v.batch_id])).rows[0]:null;
        const part=v?.execution?.parts?.[req.params.part];if(!part)throw new AccessError('generation_not_found',404);
        if(part.resolution){if(part.resolution.outcome!==req.body.outcome)throw new AccessError('resolution_conflict',409);return {duplicate:true};}
        if(part.state!=='ambiguous'||!['failed','partially_ready'].includes(v.state))throw new AccessError('not_uncertain',409);
        if(req.body.outcome==='confirmed_success') {
          const key=req.body.objectKey;const prefix=`user-uploads/${v.user_id}/generations/Generation-${v.id}${batch.source.kind==='session'?`-${req.params.part}`:''}.`;
          if(typeof key!=='string'||!['wav','mp3','ogg'].some(ext=>key===prefix+ext)||!inspectArtifact)throw new AccessError('invalid_resolution_artifact',400);
          Object.assign(part,await inspectArtifact(key));part.objectKey=key;part.state='ready';delete part.error;
        }else {part.state='failed';part.error='provider_confirmed_failure';}
        part.resolution={outcome:req.body.outcome,reason:req.body.reason,actorId:req.user.id,at:new Date().toISOString(),providerReference:String(req.body.providerReference??'').slice(0,200)};
        v.execution.saved=false;v.execution.message='Reconciliation confirmed; finalizing retained results';
        if(batch.source.kind==='session'){
          for(const p of Object.values(v.execution.parts))if(p.state==='queued'){p.state='failed';p.error='unsubmitted_part_requires_explicit_retry';}
          await c.query("UPDATE ysong_generation_versions SET execution=$2,state='finalizing',updated_at=now() WHERE id=$1",[v.id,v.execution]);
        }
        else {
          const success=part.state==='ready';
          if(v.reconciliation==='reserved'&&batch.charged)await c.query('UPDATE ysong_quota_periods SET reserved=reserved-1,used=used+$2 WHERE id=$1',[batch.quota_period_id,success?1:0]);
          await c.query('UPDATE ysong_generation_versions SET execution=$2,state=$3,reconciliation=$4,result=$5,updated_at=now() WHERE id=$1',[v.id,v.execution,success?'ready':'failed',success?'consumed':'released',success?{objectKey:part.objectKey,audioHash:part.hash,bytes:part.bytes}:null]);
        }
        await c.query('INSERT INTO ysong_admin_audit(id,actor_id,target_id,action,reason,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6,$7)',[crypto.randomUUID(),req.user.id,v.user_id,'render_reconciliation',req.body.reason,{generationId:v.id,part:req.params.part,state:'uncertain'},part.resolution]);
        return {reconciled:true};
      });res.json(result);
    }));
    app.post('/api/generations/batches',requireAuth,wrap(async(req,res)=>{
      quantityOf(req.body.quantity); const source=sessionSource(req.body);
      if(req.body.parentId && !uuid.test(req.body.parentId))throw new AccessError('parent_not_found',404);
      if(req.body.parentId) {
        const parent=(await pool.query('SELECT v.id,b.source FROM ysong_generation_versions v JOIN ysong_generation_batches b ON b.id=v.batch_id WHERE v.id=$1 AND v.user_id=$2',[req.body.parentId,req.user.id])).rows[0];
        if(!parent)throw new AccessError('parent_not_found',404);
        source.lineageRootId=parent.source.lineageRootId??parent.id;
        source.lineageVersion=(parent.source.lineageVersion??1)+1;
      }
      const batch=await service.reserve(req.user.id,{quantity:req.body.quantity,source,requestKey:req.body.requestKey,parentId:req.body.parentId});
      res.status(batch.replay?200:202).json(batch);
    }));
    app.get('/api/generations/:id/project',requireAuth,wrap(async(req,res)=>{
      if(!uuid.test(req.params.id))throw new AccessError('generation_not_found',404);
      const v=(await pool.query('SELECT * FROM ysong_generation_versions WHERE id=$1 AND user_id=$2',[req.params.id,req.user.id])).rows[0];
      if(!v?.execution?.saved)throw new AccessError('project_not_ready',409);
      const state=(await pool.query('SELECT state FROM user_client_state WHERE user_id=$1',[req.user.id])).rows[0]?.state;
      res.json({projectId:v.project_id,name:JSON.parse(state['ysong:projects:v1']).find(p=>p.id===v.project_id)?.name,project:JSON.parse(state[`ysong:daw:${v.project_id}`])});
    }));
    app.post('/api/generations/:id/retry-finalization',requireAuth,wrap(async(req,res)=>{
      if(!uuid.test(req.params.id))throw new AccessError('generation_not_found',404);
      // No provider execution on retry: only recover durable parts and project finalization.
      const rows=(await pool.query("UPDATE ysong_generation_versions SET state='finalizing',updated_at=now() WHERE id=$1 AND user_id=$2 AND reconciliation IN ('reserved','consumed') AND execution IS NOT NULL AND state='failed' AND EXISTS(SELECT 1 FROM jsonb_each(execution->'parts') p WHERE p.value->>'state'='ready') AND NOT EXISTS(SELECT 1 FROM jsonb_each(execution->'parts') p WHERE p.value->>'state' NOT IN ('ready','failed','ambiguous')) RETURNING id",[req.params.id,req.user.id])).rows;
      if(!rows.length)throw new AccessError('retry_not_eligible',409);
      res.status(202).json(rows[0]);
    }));
    app.post('/api/generations/:id/retry',requireAuth,wrap(async(req,res)=>{
      if(!uuid.test(req.params.id))throw new AccessError('generation_not_found',404);
      assertCapability(await service.access(req.user.id,req.user.issuedAt),'generation');
      const result=await service.transaction(async c=>{
        const account=await service.account(c,req.user.id,true);
        const ent=effectiveEntitlement(account,(await c.query('SELECT * FROM ysong_plans')).rows);assertCapability(ent,'generation');
        const v=(await c.query('SELECT * FROM ysong_generation_versions WHERE id=$1 AND user_id=$2 FOR UPDATE',[req.params.id,req.user.id])).rows[0];
        if(!v?.execution || !['failed','partially_ready'].includes(v.state) || Object.values(v.execution.parts).some(p=>p.state==='ambiguous'))throw new AccessError('retry_not_eligible',409);
        const parts=Object.values(v.execution.parts);
        if(!parts.some(p=>p.state==='failed'))throw new AccessError('retry_not_eligible',409);
        const b=(await c.query('SELECT * FROM ysong_generation_batches WHERE id=$1',[v.batch_id])).rows[0];
        if(v.reconciliation==='released'&&b.charged) {
          if(account.account_status!=='active'||account.generation_disabled)throw new AccessError('generation_disabled');
          const updated=await c.query('UPDATE ysong_quota_periods SET reserved=reserved+1 WHERE id=$1 AND ends_at>now() AND used+reserved+1<=$2 RETURNING id',[b.quota_period_id,ent.quota??0]);
          if(!updated.rows.length)throw new AccessError('retry_quota_unavailable_create_variation',409);
        }
        for(const part of parts)if(part.state==='failed'){part.state='queued';delete part.error;}
        v.execution.saved=false;v.execution.message='Retry queued; retained parts will not render again';
        return (await c.query("UPDATE ysong_generation_versions SET state='queued',execution=$2,reconciliation=$3,updated_at=now() WHERE id=$1 RETURNING id",[v.id,v.execution,v.reconciliation==='released'?'reserved':v.reconciliation])).rows[0];
      });res.status(202).json(result);
    }));
  }
  return { tick,start,register };
}
