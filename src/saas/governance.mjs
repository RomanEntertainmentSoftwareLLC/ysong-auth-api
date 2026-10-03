import crypto from 'node:crypto';
import {notifySaas} from './notifications.mjs';
import {approvedPolicy} from './policies.mjs';
import { AccessError } from './service.mjs';
import { classifyCost } from './metering.mjs';
import { ContentRightsRecordSchema, evaluateContentRightsGate, contentRightsEvidenceHash } from '../contentRights/gate.mjs';
export function initialModeration(contentType,buffer=Buffer.alloc(0)) {const header=buffer.subarray(0,512);const image=contentType.startsWith('image/')||header.subarray(0,4).equals(Buffer.from([137,80,78,71]))||header[0]===255&&header[1]===216||header.toString('ascii',0,3)==='GIF'||header.toString('ascii',8,12)==='WEBP'||/<svg\b/i.test(header.toString());return image?'needs_review':'clear';}
export const artworkPolicy={allowed:['cleavage','swimwear','lingerie','shirtless people','non-explicit partial nudity'],blocked:['visible nipples','visible areola','visible genitalia','exposed pubic hair','explicit sexual content']};
export function createGovernance({pool,service,enabled,assertOwnedObjectKey}) {
 async function recordUpload(userId,key,buffer,contentType){if(!enabled())return;
  const hash=crypto.createHash('sha256').update(buffer).digest('hex');
  await pool.query(`INSERT INTO ysong_content_reviews(object_key,owner_user_id,content_hash,state,evidence) VALUES($1,$2,$3,$4,$5)
   ON CONFLICT(object_key) DO UPDATE SET content_hash=excluded.content_hash,state=CASE WHEN ysong_content_reviews.content_hash=excluded.content_hash THEN ysong_content_reviews.state ELSE excluded.state END,rights_record=CASE WHEN ysong_content_reviews.content_hash=excluded.content_hash THEN ysong_content_reviews.rights_record ELSE NULL END,evidence=CASE WHEN ysong_content_reviews.content_hash=excluded.content_hash THEN ysong_content_reviews.evidence ELSE excluded.evidence END,updated_at=now()`,[key,userId,hash,initialModeration(contentType,buffer),{contentType,visualClassification:'not_performed',artworkPolicy}]);
 }
 async function assertPublic(key){if(!enabled())return;const r=(await pool.query('SELECT * FROM ysong_content_reviews WHERE object_key=$1',[key])).rows[0];
  if(!r||!['clear','restored'].includes(r.state))throw new AccessError('content_requires_review',403);
  if(!r.rights_record||!evaluateContentRightsGate(r.rights_record,'public').allowed)throw new AccessError('rights_confirmation_required',403);
 }
 function register(app,requireAuth){
  const wrap=fn=>async(req,res)=>{if(!enabled())return res.status(503).json({error:'saas_not_enabled'});try{await fn(req,res);}catch(e){res.status(e instanceof AccessError?e.status:503).json({error:e instanceof AccessError?e.code:'governance_unavailable'});}};
  async function admin(c,id){const a=await service.account(c,id);if(a?.account_status!=='active'||!['admin','superadmin'].includes(a.role))throw new AccessError('admin_required');}
  app.get('/api/account/policies',requireAuth,wrap(async(req,res)=>{
   const policies=(await pool.query('SELECT p.*,a.accepted_at FROM ysong_policy_versions p LEFT JOIN ysong_policy_acceptances a ON a.policy_id=p.policy_id AND a.version=p.version AND a.user_id=$1 WHERE p.active',[req.user.id])).rows;
   res.json({policies:policies.map(p=>({...p,approved:approvedPolicy(p)})),configured:policies.length>=6&&policies.every(approvedPolicy),legalReview:'ATTORNEY REVIEW REQUIRED until published versions are approved'});
  }));
  app.post('/api/account/policies/accept',requireAuth,wrap(async(req,res)=>{
   if(req.body?.accepted!==true)throw new AccessError('explicit_acceptance_required',400);
   const p=(await pool.query('SELECT * FROM ysong_policy_versions WHERE policy_id=$1 AND version=$2 AND active',[req.body.policyId,req.body.version])).rows[0];if(!approvedPolicy(p))throw new AccessError('policy_version_not_current',409);
   const r=await pool.query('INSERT INTO ysong_policy_acceptances(user_id,policy_id,version) SELECT $1,policy_id,version FROM ysong_policy_versions WHERE policy_id=$2 AND version=$3 AND active AND approved ON CONFLICT DO NOTHING RETURNING accepted_at',[req.user.id,req.body.policyId,req.body.version]);
   if(!r.rows.length&&!(await pool.query('SELECT 1 FROM ysong_policy_acceptances a JOIN ysong_policy_versions p USING(policy_id,version) WHERE a.user_id=$1 AND a.policy_id=$2 AND a.version=$3 AND p.active AND p.approved',[req.user.id,req.body.policyId,req.body.version])).rows.length)throw new AccessError('policy_version_stale_or_unapproved',409);res.json({accepted:true});
  }));
  app.post('/api/content/rights',requireAuth,wrap(async(req,res)=>{
   const key=assertOwnedObjectKey(req.user.id,req.body?.objectKey);const record=ContentRightsRecordSchema.parse(req.body.record);
   if(record.evidence.subject.ownerUserId!==req.user.id||record.evidence.subject.objectKey!==key||record.review!==null)throw new AccessError('invalid_rights_owner_or_review',400);
   const result=await pool.query('UPDATE ysong_content_reviews SET rights_record=$3,updated_at=now() WHERE object_key=$1 AND owner_user_id=$2 RETURNING object_key',[key,req.user.id,record]);if(!result.rows.length)throw new AccessError('content_not_found',404);res.json({saved:true});
  }));
  app.post('/api/content/rights/attest',requireAuth,wrap(async(req,res)=>{
   if(req.body.accepted!==true)throw new AccessError('explicit_acceptance_required',400);
   const key=assertOwnedObjectKey(req.user.id,req.body.objectKey);
   const policy=(await pool.query("SELECT p.* FROM ysong_policy_versions p JOIN ysong_policy_acceptances a USING(policy_id,version) WHERE p.policy_id='upload-rights' AND p.active AND p.approved AND a.user_id=$1",[req.user.id])).rows[0];if(!approvedPolicy(policy))throw new AccessError('policy_acceptance_required',403);
   const at=new Date().toISOString();const record=ContentRightsRecordSchema.parse({evidence:{subject:{ownerUserId:req.user.id,objectKey:key},claimedRelease:null,matches:[],identitySupport:[],sources:[{provider:'user claim',source:'user_upload',referenceId:String(req.body.sourceReference??'').slice(0,240)||null,observedAt:at}],attestation:{userId:req.user.id,statementVersion:policy.version,uses:req.body.uses??['public'],assertedAt:at,revokedAt:null}},review:null});
   const result=await pool.query('UPDATE ysong_content_reviews SET rights_record=$3,updated_at=now() WHERE object_key=$1 AND owner_user_id=$2 RETURNING object_key',[key,req.user.id,record]);if(!result.rows.length)throw new AccessError('content_not_found',404);res.json({saved:true,state:'unverified',ownershipProven:false});
  }));
  app.get('/api/admin/content',requireAuth,wrap(async(req,res)=>{await admin(pool,req.user.id);res.json({content:(await pool.query('SELECT * FROM ysong_content_reviews ORDER BY updated_at DESC LIMIT 100')).rows,policy:artworkPolicy});}));
  app.post('/api/admin/content/review',requireAuth,wrap(async(req,res)=>{
   if(!['clear','needs_review','restricted','hidden','removed','restored'].includes(req.body.state)||typeof req.body.reason!=='string'||req.body.reason.trim().length<10)throw new AccessError('review_reason_required',400);
   await service.transaction(async c=>{await admin(c,req.user.id);const before=(await c.query('SELECT * FROM ysong_content_reviews WHERE object_key=$1 FOR UPDATE',[req.body.objectKey])).rows[0];if(!before)throw new AccessError('content_not_found',404);
    await c.query('UPDATE ysong_content_reviews SET state=$2,evidence=evidence||$3::jsonb,updated_at=now() WHERE object_key=$1',[before.object_key,req.body.state,{reviewer:req.user.id,reason:req.body.reason}]);
    if(['hidden','removed','restricted'].includes(req.body.state)){
      const affected=(await c.query("UPDATE world_tracks SET status='hidden' WHERE status='published' AND (audio_object_key=$1 OR release_id IN (SELECT id FROM world_releases WHERE artwork_object_key=$1)) RETURNING id",[before.object_key])).rows.map(r=>r.id);
      await c.query('UPDATE ysong_content_reviews SET evidence=evidence||$2::jsonb WHERE object_key=$1',[before.object_key,{hiddenTrackIds:[...new Set([...(before.evidence.hiddenTrackIds??[]),...affected])]}]);
    }else if(req.body.state==='restored'&&before.evidence.hiddenTrackIds?.length){
      await c.query("UPDATE world_tracks t SET status='published' WHERE status='hidden' AND id=ANY($1::uuid[]) AND NOT EXISTS(SELECT 1 FROM ysong_content_reviews cr WHERE cr.object_key IN (t.audio_object_key,(SELECT r.artwork_object_key FROM world_releases r WHERE r.id=t.release_id)) AND cr.state NOT IN ('clear','restored'))",[before.evidence.hiddenTrackIds]);
    }
    if(req.body.approveRights===true){if(!before.rights_record)throw new AccessError('rights_record_required',400);const record=ContentRightsRecordSchema.parse(before.rights_record);record.review={state:'approved',uses:record.evidence.attestation?.uses??['public'],evidenceHash:contentRightsEvidenceHash(record.evidence),reviewerId:req.user.id,decidedAt:new Date().toISOString()};ContentRightsRecordSchema.parse(record);await c.query('UPDATE ysong_content_reviews SET rights_record=$2 WHERE object_key=$1',[before.object_key,record]);}
    await c.query('INSERT INTO ysong_admin_audit(id,actor_id,target_id,action,reason,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6,$7)',[crypto.randomUUID(),req.user.id,before.owner_user_id,'content_review',req.body.reason,{objectKey:before.object_key,state:before.state},{state:req.body.state}]);
     if(before.state!==req.body.state)await notifySaas(c,before.owner_user_id,`content:${before.object_key}:${req.body.state}:${before.updated_at.toISOString()}`,'Content review updated',`Content status: ${req.body.state}. Review your rights and content settings.`);
   });res.json({reviewed:true});
  }));
  app.post('/api/takedowns',requireAuth,wrap(async(req,res)=>{
    if(typeof req.body?.contactReference!=='string'||!req.body.contactReference.trim()||req.body.contactReference.length>500||typeof req.body.claim!=='string'||req.body.claim.length<20||req.body.claim.length>10000)throw new AccessError('invalid_takedown',400);
   const id=crypto.randomUUID();await pool.query('INSERT INTO ysong_takedown_cases(id,claimant_user_id,object_key,contact_reference,claim) VALUES($1,$2,$3,$4,$5)',[id,req.user.id,req.body.objectKey,req.body.contactReference,req.body.claim]);res.status(201).json({id,state:'submitted',legalReview:'ATTORNEY REVIEW REQUIRED'});
  }));
  app.get('/api/admin/takedowns',requireAuth,wrap(async(req,res)=>{await admin(pool,req.user.id);res.json({cases:(await pool.query('SELECT t.*,r.owner_user_id,(SELECT count(*) FROM ysong_takedown_cases prior JOIN ysong_content_reviews cr ON cr.object_key=prior.object_key WHERE cr.owner_user_id=r.owner_user_id AND prior.state=\'removed\') AS prior_removals FROM ysong_takedown_cases t JOIN ysong_content_reviews r ON r.object_key=t.object_key ORDER BY t.updated_at DESC LIMIT 100')).rows});}));
  app.post('/api/admin/takedowns/:id/decision',requireAuth,wrap(async(req,res)=>{
   if(!['needs_review','removed','restored','rejected'].includes(req.body?.state)||typeof req.body.reason!=='string'||req.body.reason.trim().length<10)throw new AccessError('decision_reason_required',400);
   await service.transaction(async c=>{await admin(c,req.user.id);const before=(await c.query('SELECT t.*,r.owner_user_id FROM ysong_takedown_cases t JOIN ysong_content_reviews r ON r.object_key=t.object_key WHERE t.id=$1 FOR UPDATE OF t',[req.params.id])).rows[0];if(!before)throw new AccessError('case_not_found',404);
    await c.query("UPDATE ysong_takedown_cases SET state=$2,decision_reason=$3,notification_state='pending',updated_at=now() WHERE id=$1",[before.id,req.body.state,req.body.reason]);
    await c.query('UPDATE ysong_takedown_cases SET notification_evidence=NULL WHERE id=$1',[before.id]);
     if(['removed','restored'].includes(req.body.state)){
      const review=(await c.query('SELECT evidence FROM ysong_content_reviews WHERE object_key=$1 FOR UPDATE',[before.object_key])).rows[0];
      await c.query('UPDATE ysong_content_reviews SET state=$2,updated_at=now() WHERE object_key=$1',[before.object_key,req.body.state]);
      if(req.body.state==='removed'){
       const ids=(await c.query("UPDATE world_tracks SET status='hidden' WHERE status='published' AND (audio_object_key=$1 OR release_id IN (SELECT id FROM world_releases WHERE artwork_object_key=$1)) RETURNING id",[before.object_key])).rows.map(r=>r.id);
       await c.query('UPDATE ysong_content_reviews SET evidence=evidence||$2::jsonb WHERE object_key=$1',[before.object_key,{hiddenTrackIds:[...new Set([...(review.evidence.hiddenTrackIds??[]),...ids])]}]);
      }else if(review.evidence.hiddenTrackIds?.length){
       await c.query("UPDATE world_tracks t SET status='published' WHERE status='hidden' AND id=ANY($1::uuid[]) AND NOT EXISTS(SELECT 1 FROM ysong_content_reviews cr WHERE cr.object_key IN (t.audio_object_key,(SELECT r.artwork_object_key FROM world_releases r WHERE r.id=t.release_id)) AND cr.state NOT IN ('clear','restored'))",[review.evidence.hiddenTrackIds]);
      }
     }
    await c.query('INSERT INTO ysong_admin_audit(id,actor_id,target_id,action,reason,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6,$7)',[crypto.randomUUID(),req.user.id,before.owner_user_id,'takedown_decision',req.body.reason,{caseId:before.id,state:before.state},{state:req.body.state,notification:'pending'}]);
    if(before.state!==req.body.state)for(const userId of new Set([before.owner_user_id,before.claimant_user_id]))await notifySaas(c,userId,`case:${before.id}:${req.body.state}:${before.updated_at.toISOString()}`,'Takedown case updated',`Case ${before.id}: ${req.body.state}. Formal notice delivery is handled separately.`);
   });res.json({decided:true,notification:'pending_manual_delivery'});
  }));
  app.post('/api/takedowns/:id/counter-notice',requireAuth,wrap(async(req,res)=>{
   if(typeof req.body?.notice!=='string'||req.body.notice.length<20||req.body.notice.length>10000)throw new AccessError('invalid_counter_notice',400);
   const r=await pool.query("UPDATE ysong_takedown_cases t SET counter_notice=$3,state='counter_notice_pending',updated_at=now() FROM ysong_content_reviews c WHERE t.id=$1 AND c.object_key=t.object_key AND c.owner_user_id=$2 RETURNING t.id",[req.params.id,req.user.id,req.body.notice]);if(!r.rows.length)throw new AccessError('case_not_found',404);res.json({submitted:true});
  }));
 }
 function policyGate(requireAuth){return (req,res,next)=>{
  if(!enabled()||req.method!=='POST'||(classifyCost(req.path)==='free'&&!['/api/uploads','/api/world/publish'].includes(req.path)))return next();
  requireAuth(req,res,async()=>{try{
   const rows=(await pool.query('SELECT p.*,a.accepted_at FROM ysong_policy_versions p LEFT JOIN ysong_policy_acceptances a ON a.policy_id=p.policy_id AND a.version=p.version AND a.user_id=$1 WHERE p.active AND p.required',[req.user.id])).rows;
   if(!['terms','privacy','upload-rights','billing','generated-output'].every(id=>rows.some(p=>p.policy_id===id&&approvedPolicy(p)))||rows.some(p=>!approvedPolicy(p)))throw new AccessError('policies_not_configured',503);
   if(rows.some(p=>!p.accepted_at))throw new AccessError('policy_acceptance_required',403);
   next();
  }catch(e){res.status(e instanceof AccessError?e.status:503).json({error:e instanceof AccessError?e.code:'policy_service_unavailable'});}});
 };}
 return {recordUpload,assertPublic,register,policyGate};
}
