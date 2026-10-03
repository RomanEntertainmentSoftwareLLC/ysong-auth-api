import crypto from 'node:crypto';
import {AccessError} from './service.mjs';
import {stripeAdapter,applySubscriptionEvent} from './billing.mjs';
import {notifySaas} from './notifications.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function registerRecoveryRoutes(app,{pool,service,requireAuth,enabled,env=process.env,billingAdapter=stripeAdapter}) {
  const wrap=fn=>async(req,res)=>{if(!enabled())return res.status(503).json({error:'saas_not_enabled'});try{await fn(req,res);}catch(e){res.status(e instanceof AccessError?e.status:503).json({error:e instanceof AccessError?e.code:'recovery_unavailable'});}};
  async function admin(c,id){const a=await service.account(c,id);if(a?.account_status!=='active'||!['admin','superadmin'].includes(a.role))throw new AccessError('admin_required');}
  function reason(req){if(typeof req.body?.reason!=='string'||req.body.reason.trim().length<10||req.body.reason.length>2000)throw new AccessError('recovery_reason_required',400);return req.body.reason.trim();}
  async function audit(c,req,target,action,before,after,id=crypto.randomUUID()) {await c.query('INSERT INTO ysong_admin_audit(id,actor_id,target_id,action,reason,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING',[id,req.user.id,target,action,reason(req),before,after]);}
  async function version(c,req){await admin(c,req.user.id);if(!uuid.test(req.params.id))throw new AccessError('generation_not_found',404);if(!(await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',[req.params.id])).rows[0].locked)throw new AccessError('render_executor_active',409);const v=(await c.query('SELECT * FROM ysong_generation_versions WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];if(!v)throw new AccessError('generation_not_found',404);return v;}
  app.get('/api/admin/recovery',requireAuth,wrap(async(req,res)=>{
    await admin(pool,req.user.id);
    const generations=(await pool.query("SELECT v.*,b.source->>'kind' AS source_kind FROM ysong_generation_versions v JOIN ysong_generation_batches b ON b.id=v.batch_id WHERE v.reconciliation='reserved' OR v.state='failed' ORDER BY v.created_at LIMIT 100")).rows;
    const billingFailures=(await pool.query('SELECT * FROM ysong_billing_failures WHERE resolved_at IS NULL ORDER BY last_seen_at DESC LIMIT 100')).rows;
    res.json({generations,billingFailures});
  }));
  app.post('/api/admin/recovery/generations/:id/review-submission',requireAuth,wrap(async(req,res)=>{
    reason(req);res.json(await service.transaction(async c=>{
      const v=await version(c,req);if(v.state==='failed'&&Object.values(v.execution?.parts??{}).some(p=>p.state==='ambiguous'))return {duplicate:true};
      if(!['generating','processing'].includes(v.state)||!v.execution?.parts||v.reconciliation!=='reserved')throw new AccessError('review_not_eligible',409);
      let changed=false;for(const p of Object.values(v.execution.parts))if(['submitted','processing'].includes(p.state)){p.state='ambiguous';p.error='operator_review_required';changed=true;}
      if(!changed)throw new AccessError('review_not_eligible',409);
      v.execution.message='Stopped executor submission requires evidence-based review; reservation retained';
      await c.query("UPDATE ysong_generation_versions SET state='failed',error_code='provider_outcome_uncertain',execution=$2,updated_at=now() WHERE id=$1",[v.id,v.execution]);
      await audit(c,req,v.user_id,'render_review_submission',{generationId:v.id,state:v.state},{state:'failed',reservation:'retained'});
      await notifySaas(c,v.user_id,`generation:${v.id}:review`,'Generation requires manual review','The provider outcome is uncertain. Your reservation is retained; do not submit a replacement.','/app?view=createSong');return {reviewRequired:true};
    }));
  }));
  app.post('/api/admin/recovery/generations/:id/cancel-queued',requireAuth,wrap(async(req,res)=>{
    reason(req);res.json(await service.transaction(async c=>{
      const v=await version(c,req);if(v.state==='cancelled')return {duplicate:true};if(v.state!=='queued'||v.reconciliation!=='reserved')throw new AccessError('cancel_not_eligible',409);
      const b=(await c.query('SELECT * FROM ysong_generation_batches WHERE id=$1',[v.batch_id])).rows[0];if(b.charged)await c.query('UPDATE ysong_quota_periods SET reserved=reserved-1 WHERE id=$1',[b.quota_period_id]);
      await c.query("UPDATE ysong_generation_versions SET state='cancelled',reconciliation='released',updated_at=now() WHERE id=$1",[v.id]);
      await audit(c,req,v.user_id,'cancel_queued_generation',{generationId:v.id,state:'queued'},{state:'cancelled'});return {cancelled:true};
    }));
  }));
  app.post('/api/admin/recovery/generations/:id/finalize',requireAuth,wrap(async(req,res)=>{
    reason(req);res.json(await service.transaction(async c=>{
      const v=await version(c,req);if(v.state==='finalizing')return {duplicate:true};const b=(await c.query('SELECT source FROM ysong_generation_batches WHERE id=$1',[v.batch_id])).rows[0];
      const parts=Object.values(v.execution?.parts??{});if(b.source.kind!=='session'||v.state!=='failed'||!parts.some(p=>p.state==='ready')||parts.some(p=>!['ready','failed','ambiguous'].includes(p.state)))throw new AccessError('finalization_not_eligible',409);
      await c.query("UPDATE ysong_generation_versions SET state='finalizing',updated_at=now() WHERE id=$1",[v.id]);await audit(c,req,v.user_id,'retry_project_finalization',{generationId:v.id,state:'failed'},{state:'finalizing',paidCall:false});return {finalizing:true};
    }));
  }));
  app.post('/api/admin/recovery/quota/:id/recount-reservations',requireAuth,wrap(async(req,res)=>{
    reason(req);if(!uuid.test(req.params.id)||!Number.isInteger(req.body.expectedReserved)||req.body.expectedReserved<0)throw new AccessError('invalid_quota_recount',400);
    res.json(await service.transaction(async c=>{
      await admin(c,req.user.id);const target=(await c.query('SELECT user_id FROM ysong_quota_periods WHERE id=$1',[req.params.id])).rows[0];if(!target)throw new AccessError('quota_period_not_found',404);
      await service.account(c,target.user_id,true);const p=(await c.query('SELECT * FROM ysong_quota_periods WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
      const count=Number((await c.query("SELECT count(*) AS reserved FROM ysong_generation_versions v JOIN ysong_generation_batches b ON b.id=v.batch_id WHERE b.quota_period_id=$1 AND b.charged AND v.reconciliation='reserved'",[p.id])).rows[0].reserved);
      if(p.reserved===count)return {duplicate:true,reserved:count};if(p.reserved!==req.body.expectedReserved)throw new AccessError('quota_period_changed',409);
      await c.query('UPDATE ysong_quota_periods SET reserved=$2 WHERE id=$1',[p.id,count]);await audit(c,req,p.user_id,'quota_reservation_recount',{periodId:p.id,reserved:p.reserved,used:p.used},{reserved:count,used:p.used});return {reserved:count};
    }));
  }));
  app.post('/api/admin/recovery/billing/:id/reconcile',requireAuth,wrap(async(req,res)=>{
    reason(req);await admin(pool,req.user.id);if(!uuid.test(req.params.id)||typeof req.body.requestKey!=='string'||! /^[\w-]{8,128}$/.test(req.body.requestKey))throw new AccessError('invalid_recovery_request',400);
    const a=await service.account(pool,req.params.id),{stripe,live}=billingAdapter(env);
    if(!a?.billing_customer_id||!a.billing_subscription_id||a.billing_live!==live)throw new AccessError('billing_profile_incomplete',409);
    const eventId=`recovery:${req.user.id}:${req.params.id}:${req.body.requestKey}`;
    if((await pool.query('SELECT 1 FROM ysong_billing_events WHERE provider=$1 AND live=$2 AND event_id=$3',['stripe',live,eventId])).rows.length)return res.json({duplicate:true});
    const sub=await stripe.subscriptions.retrieve(a.billing_subscription_id),customer=typeof sub.customer==='string'?sub.customer:sub.customer?.id;
    if(sub.livemode!==live||customer!==a.billing_customer_id||sub.id!==a.billing_subscription_id)throw new AccessError('billing_recovery_owner_or_mode_mismatch',409);
    const event={id:eventId,type:sub.status==='canceled'?'customer.subscription.deleted':'customer.subscription.updated',created:Math.floor(Date.now()/1000),livemode:live};
    res.json(await applySubscriptionEvent(service,event,sub,{id:crypto.randomUUID(),actorId:req.user.id,reason:reason(req),requestKey:req.body.requestKey}));
  }));
  app.post('/api/admin/recovery/billing/:id/link-profile',requireAuth,wrap(async(req,res)=>{
    reason(req);await admin(pool,req.user.id);if(!uuid.test(req.params.id)||typeof req.body.customerId!=='string'||!req.body.customerId.startsWith('cus_')||typeof req.body.subscriptionId!=='string'||!req.body.subscriptionId.startsWith('sub_'))throw new AccessError('invalid_billing_profile',400);
    const {stripe,live}=billingAdapter(env),customer=await stripe.customers.retrieve(req.body.customerId),subscription=await stripe.subscriptions.retrieve(req.body.subscriptionId);
    const owner=typeof subscription.customer==='string'?subscription.customer:subscription.customer?.id;
    if(customer.deleted||customer.livemode!==live||customer.metadata?.ysong_user_id!==req.params.id||subscription.livemode!==live||owner!==customer.id)throw new AccessError('billing_profile_owner_or_mode_mismatch',409);
    res.json(await service.transaction(async c=>{
      await admin(c,req.user.id);const a=await service.account(c,req.params.id,true);if(!a)throw new AccessError('account_not_found',404);
      if(a.billing_customer_id&&(a.billing_customer_id!==customer.id||a.billing_live!==live)||a.billing_subscription_id&&a.billing_subscription_id!==subscription.id)throw new AccessError('billing_profile_conflict',409);
      if(a.billing_customer_id===customer.id&&a.billing_subscription_id===subscription.id)return {duplicate:true};
      await c.query("UPDATE ysong_account_access SET billing_provider='stripe',billing_live=$2,billing_customer_id=$3,billing_subscription_id=$4,updated_at=now() WHERE user_id=$1",[a.user_id,live,customer.id,subscription.id]);
      await audit(c,req,a.user_id,'billing_profile_link',{customerId:a.billing_customer_id,subscriptionId:a.billing_subscription_id},{customerId:customer.id,subscriptionId:subscription.id,entitlementUnchanged:true});return {linked:true,entitlementUnchanged:true};
    }));
  }));
  app.post('/api/admin/recovery/takedowns/:id/notification',requireAuth,wrap(async(req,res)=>{
    reason(req);if(!['delivered','failed'].includes(req.body.status)||typeof req.body.reference!=='string'||req.body.reference.trim().length<3||req.body.reference.length>500||typeof req.body.expectedUpdatedAt!=='string')throw new AccessError('notification_evidence_required',400);
    res.json(await service.transaction(async c=>{
      await admin(c,req.user.id);const before=(await c.query('SELECT * FROM ysong_takedown_cases WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];if(!before)throw new AccessError('case_not_found',404);
      if(before.notification_state===req.body.status&&before.notification_evidence?.reference===req.body.reference)return {duplicate:true};
      if(before.updated_at.toISOString()!==req.body.expectedUpdatedAt)throw new AccessError('case_changed',409);
      await c.query('UPDATE ysong_takedown_cases SET notification_state=$2,notification_evidence=$3 WHERE id=$1',[before.id,req.body.status,{reference:req.body.reference,actorId:req.user.id,at:new Date().toISOString()}]);
      await audit(c,req,null,'takedown_notification_record',{caseId:before.id,status:before.notification_state},{status:req.body.status,reference:req.body.reference});return {recorded:true};
    }));
  }));
  app.post('/api/admin/recovery/billing-events/:id/replay',requireAuth,wrap(async(req,res)=>{
    reason(req);await admin(pool,req.user.id);const {stripe,live}=billingAdapter(env);
    const failure=(await pool.query('SELECT * FROM ysong_billing_failures WHERE live=$1 AND event_id=$2',[live,req.params.id])).rows[0];if(!failure)throw new AccessError('billing_failure_not_found',404);if(failure.resolved_at)return res.json({duplicate:true});
    const event=await stripe.events.retrieve(failure.event_id);
    if(event.id!==failure.event_id||event.livemode!==live||event.type!==failure.event_type)throw new AccessError('billing_event_mode_mismatch',409);
    const sub=event.type.startsWith('customer.subscription.')?(event.type==='customer.subscription.deleted'?event.data.object:await stripe.subscriptions.retrieve(event.data.object.id)):null;
    const result=await applySubscriptionEvent(service,event,sub,{id:crypto.randomUUID(),actorId:req.user.id,reason:reason(req),requestKey:event.id});
    if(result.duplicate||result.stale)await service.transaction(async c=>{await c.query('UPDATE ysong_billing_failures SET resolved_at=now() WHERE live=$1 AND event_id=$2',[live,event.id]);await audit(c,req,null,'billing_event_replay',{eventId:event.id},{...result,resolved:true});});
    res.json(result);
  }));
}
