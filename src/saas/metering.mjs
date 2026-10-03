import crypto from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import { AccessError, assertCapability } from './service.mjs';
const paidContext=new AsyncLocalStorage();
export function assertPaidBoundary(){if(!paidContext.getStore()?.usageId)throw new AccessError('unmetered_provider_call_disabled',503);}
export function classifyCost(path,method='POST') {
 if(method!=='POST')return 'free';
 if(path==='/api/music/generate'||path==='/api/generations/batches')return 'quota';
 if(path==='/chat'||/\/ai\/respond$|\/critique\/ai-summary$/.test(path))return 'assistant';
 if(/^\/api\/(artwork\/generate|composer\/|sound-designer\/|stem-composer\/)/.test(path))return 'disabled';
 return 'free';
}
export function createMeteringGate({pool,service,requireAuth,enabled,artworkProvider=()=>String(process.env.ARTWORK_AI_PROVIDER||'openai')}) {
 return (req,res,next)=>{
  const kind=classifyCost(req.path,req.method);if(!enabled()||kind==='free'||kind==='quota')return next();
  requireAuth(req,res,async()=>{try{
   const entitlement=await service.access(req.user.id,req.user.issuedAt);assertCapability(entitlement,kind==='assistant'?'assistant':req.path.includes('artwork')?'artwork':'generation');
   if(kind==='disabled'&&!entitlement.superadmin)throw new AccessError('generation_executor_not_integrated',503);
   const provider=req.path.includes('artwork')?artworkProvider():'openai';await service.providerEnabled(provider);
   const key=req.get('idempotency-key')??req.body?.requestKey??(entitlement.superadmin?crypto.randomUUID():null);
   if(typeof key!=='string'||! /^[\w-]{8,128}$/.test(key))throw new AccessError('idempotency_key_required',400);
   const hash=crypto.createHash('sha256').update(JSON.stringify({path:req.path,body:req.body})).digest('hex');
   const id=await service.transaction(async c=>{
    await service.account(c,req.user.id,true);
    const existing=(await c.query('SELECT request_hash FROM ysong_usage_events WHERE user_id=$1 AND request_key=$2',[req.user.id,key])).rows[0];
    if(existing)throw new AccessError(existing.request_hash===hash?'request_already_submitted':'idempotency_conflict',409);
    if(!entitlement.superadmin){const plan=(await c.query('SELECT usage_limits FROM ysong_plans WHERE id=$1',[entitlement.planId])).rows[0];const limit=plan?.usage_limits?.assistant;
     if(!Number.isInteger(limit)||limit<0)throw new AccessError('assistant_limit_not_configured',503);
     const used=Number((await c.query("SELECT count(*) AS used FROM ysong_usage_events WHERE user_id=$1 AND capability='assistant' AND created_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",[req.user.id])).rows[0].used);
     if(used>=limit)throw new AccessError('assistant_quota_exhausted',409);
    }
    const model=req.path.includes('artwork')?(provider==='xai'?process.env.XAI_IMAGE_MODEL||'grok-imagine-image-2.0':process.env.OPENAI_IMAGE_MODEL||'gpt-image-2.5-sunburst'):process.env.OPENAI_MODEL||'gpt-5.6';
    const id=crypto.randomUUID();await c.query('INSERT INTO ysong_usage_events(id,user_id,request_key,request_hash,capability,provider,model,admin_exempt) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,req.user.id,key,hash,kind,provider,model,entitlement.superadmin]);return id;
   });
   res.once('finish',()=>{void pool.query('UPDATE ysong_usage_events SET state=$2,updated_at=now() WHERE id=$1',[id,res.statusCode<400?'confirmed_success':'uncertain']).catch(()=>{});});
   res.once('close',()=>{if(!res.writableFinished)void pool.query("UPDATE ysong_usage_events SET state='uncertain',updated_at=now() WHERE id=$1 AND state='submitted'",[id]).catch(()=>{});});
   paidContext.run({usageId:id,userId:req.user.id},next);
  }catch(e){res.status(e instanceof AccessError?e.status:503).json({error:e instanceof AccessError?e.code:'usage_service_unavailable'});}});
 };
}
