import Stripe from 'stripe';
import { AccessError, assertRecoveryTarget } from './service.mjs';
import {notifySaas} from './notifications.mjs';

export const subscriptionEvents = Object.freeze(['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted']);
export const billingWebhookEvents = Object.freeze([...subscriptionEvents,'invoice.paid','invoice.payment_failed']);
const customerOf = object => typeof object?.customer === 'string' ? object.customer : object?.customer?.id;

export function stripeAdapter(env = process.env) {
  const secret = env.STRIPE_SECRET_KEY;
  const live = env.BILLING_MODE === 'live';
  if (!['test','live'].includes(env.BILLING_MODE) || !secret?.startsWith(live ? 'sk_live_' : 'sk_test_')) throw new AccessError('billing_not_configured',503);
  return { live, stripe: new Stripe(secret, { timeout: 20000, maxNetworkRetries: 1 }) };
}
export function verifyBillingEvent(raw, signature, env = process.env) {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new AccessError('billing_not_configured',503);
  let event;
  if (!Buffer.isBuffer(raw)) throw new AccessError('invalid_webhook_signature',400);
  try { event = Stripe.webhooks.constructEvent(raw, signature, env.STRIPE_WEBHOOK_SECRET); }
  catch { throw new AccessError('invalid_webhook_signature',400); }
  if (!['test','live'].includes(env.BILLING_MODE) || event.livemode !== (env.BILLING_MODE === 'live')) throw new AccessError('billing_mode_mismatch',400);
  return event;
}
export async function applySubscriptionEvent(service,event,subscription,recovery=null,retrieve=null) {
  if (!event?.id || typeof event.livemode !== 'boolean' || !Number.isSafeInteger(event.created) || event.created < 0) throw new AccessError('invalid_billing_event',400);
  return service.transaction(async c => {
    const authorizeRecovery = async () => {
      if (!recovery) return;
      const target = (await c.query("SELECT * FROM ysong_account_access WHERE billing_provider='stripe' AND billing_live=$1 AND billing_customer_id=$2",[event.livemode,customerOf(subscription??event.data?.object)])).rows[0];
      assertRecoveryTarget(await service.account(c,recovery.actorId),target);
    };
    const settled = async result => {
      await c.query('UPDATE ysong_billing_failures SET resolved_at=now() WHERE live=$1 AND event_id=$2',[event.livemode,event.id]);
      return result;
    };
    const inserted = await c.query('INSERT INTO ysong_billing_events(provider,live,event_id,event_type,event_created) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING event_id',['stripe',event.livemode,event.id,event.type,event.created]);
    await authorizeRecovery();
    if (!inserted.rows.length) return settled({ duplicate:true });
    if (['invoice.paid','invoice.payment_failed'].includes(event.type)){
      const invoice=event.data?.object;const customer=typeof invoice?.customer==='string'?invoice.customer:invoice?.customer?.id;
      const account=(await c.query("SELECT user_id FROM ysong_account_access WHERE billing_provider='stripe' AND billing_live=$1 AND billing_customer_id=$2",[event.livemode,customer])).rows[0];
      if(!account)throw new AccessError('billing_customer_not_linked',409);
      await notifySaas(c,account.user_id,`billing:${event.id}`,event.type==='invoice.paid'?'Payment confirmed':'Payment requires attention',event.type==='invoice.paid'?'Stripe confirmed your invoice payment. Subscription access follows the server subscription state.':'Review your payment method in billing.');
      if(recovery)await c.query('INSERT INTO ysong_admin_audit(id,actor_id,target_id,action,reason,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6,$7)',[recovery.id,recovery.actorId,account.user_id,'billing_event_replay',recovery.reason,{eventId:event.id},{notified:true,requestKey:recovery.requestKey}]);
      await c.query('UPDATE ysong_billing_failures SET resolved_at=now() WHERE live=$1 AND event_id=$2',[event.livemode,event.id]);return {notified:true};
    }
    if (!subscriptionEvents.includes(event.type)) return settled({ ignored:true });
    const customerId = customerOf(subscription);
    if (!subscription?.id || !customerId || subscription.livemode !== event.livemode) throw new AccessError('billing_subscription_owner_or_mode_mismatch',409);
    const a = (await c.query("SELECT * FROM ysong_account_access WHERE billing_provider='stripe' AND billing_live=$1 AND billing_customer_id=$2 FOR UPDATE",[event.livemode,customerId])).rows[0];
    if (!a) throw new AccessError('billing_customer_not_linked',409);
    if (event.created < Number(a.last_billing_event_at)) return settled({ stale:true });
    // Fetch only after locking the customer: concurrent deliveries must not apply
    // snapshots fetched in the opposite order. Duplicate/stale retries need no API call.
    if (retrieve) {
      const current = await retrieve(subscription.id);
      if (current?.id !== subscription.id || customerOf(current) !== customerId || current.livemode !== event.livemode) throw new AccessError('billing_subscription_owner_or_mode_mismatch',409);
      subscription = current;
      // The operator may have lost access while the provider request was pending.
      await authorizeRecovery();
    }
    if (event.type === 'customer.subscription.deleted' && subscription.status !== 'canceled') throw new AccessError('invalid_deleted_subscription',400);
    if (event.created === Number(a.last_billing_event_at) && a.subscription_status === 'canceled' && a.billing_subscription_id === subscription.id && subscription.status !== 'canceled') return settled({ stale:true });
    if (a.billing_subscription_id && a.billing_subscription_id!==subscription.id) {
      if (event.type==='customer.subscription.deleted') return settled({ stale:true });
      if (['active','trialing','past_due','unpaid'].includes(a.subscription_status)) throw new AccessError('multiple_subscriptions_require_review',409);
    }
    const item = subscription?.items?.data?.[0];
    const priceId = item?.price?.id;
    const plan = (await c.query('SELECT id FROM ysong_plans WHERE billing_prices->>$1=$2',[`stripe:${event.livemode?'live':'test'}`,priceId??''])).rows;
    const active = ['active','trialing'].includes(subscription.status);
    if (active && (plan.length !== 1 || subscription.items?.data?.length !== 1)) throw new AccessError('billing_price_not_configured',503);
    const start = subscription.current_period_start ?? item?.current_period_start;
    const end = subscription.current_period_end ?? item?.current_period_end;
    if (active && (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)) throw new AccessError('invalid_billing_period',400);
    await c.query(`UPDATE ysong_account_access SET plan_id=$2,subscription_status=$3,billing_subscription_id=$4,
      billing_price_id=$5,billing_product_id=$6,period_start=$7,period_end=$8,cancel_at_period_end=$9,
      last_billing_event_at=$10,updated_at=now() WHERE user_id=$1`,[a.user_id,active?plan[0].id:'free',subscription.status,subscription.id,priceId??null,
      typeof item?.price?.product==='string'?item.price.product:null,start?new Date(start*1000):null,end?new Date(end*1000):null,!!subscription.cancel_at_period_end,event.created]);
    await c.query('UPDATE ysong_billing_events SET transition=$4 WHERE provider=$1 AND live=$2 AND event_id=$3',[
      'stripe',event.livemode,event.id,{userId:a.user_id,before:{planId:a.plan_id,status:a.subscription_status},after:{planId:active?plan[0].id:'free',status:subscription.status,subscriptionId:subscription.id}}]);
    if(a.subscription_status!==subscription.status||a.cancel_at_period_end!==!!subscription.cancel_at_period_end||a.billing_price_id!==priceId)await notifySaas(c,a.user_id,`billing:${event.id}`,'Subscription updated',`Status: ${subscription.status}${subscription.cancel_at_period_end?'; cancellation scheduled':''}. Review billing for the current period and plan.`);
    if(recovery)await c.query('INSERT INTO ysong_admin_audit(id,actor_id,target_id,action,reason,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6,$7)',[recovery.id,recovery.actorId,a.user_id,'billing_reconciliation',recovery.reason,{plan:a.plan_id,status:a.subscription_status},{plan:active?plan[0].id:'free',status:subscription.status,requestKey:recovery.requestKey}]);
    await c.query('UPDATE ysong_billing_failures SET resolved_at=now() WHERE live=$1 AND event_id=$2',[event.livemode,event.id]);
    // Normal billing never writes role or override columns.
    return { applied:true };
  });
}
export function registerBillingWebhook(app,express,service,enabled,env=process.env,billingAdapter=stripeAdapter) {
  app.post('/api/billing/webhook',express.raw({type:'application/json',limit:'1mb'}),async(req,res)=>{
    if (!enabled()&&env.BILLING_WEBHOOK_ENABLED!=='1') return res.status(503).json({error:'saas_not_enabled'});
    let event;
    try {
      event=verifyBillingEvent(req.body,req.get('stripe-signature'),env);
      if (!subscriptionEvents.includes(event.type)) return res.json(await applySubscriptionEvent(service,event,null));
      const {stripe}=billingAdapter(env);
      return res.json(await applySubscriptionEvent(service,event,event.data.object,null,
        event.type==='customer.subscription.deleted'?null:id=>stripe.subscriptions.retrieve(id)));
    } catch(e) {
      if(event)await service.transaction(c=>c.query('INSERT INTO ysong_billing_failures(live,event_id,event_type,error_code,object_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(live,event_id) DO UPDATE SET error_code=excluded.error_code,last_seen_at=now(),resolved_at=NULL',[event.livemode,event.id,event.type,e instanceof AccessError?e.code:'billing_temporarily_unavailable',event.data?.object?.id??null])).catch(()=>{});
      return res.status(e instanceof AccessError?e.status:503).json({error:e instanceof AccessError?e.code:'billing_temporarily_unavailable'});
    }
  });
}
