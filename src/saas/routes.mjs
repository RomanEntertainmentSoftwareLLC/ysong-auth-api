import crypto from 'node:crypto';
import { AccessError, assertCapability } from './service.mjs';
import { stripeAdapter } from './billing.mjs';
import { publicPlan } from './plans.mjs';
import {approvedPolicy} from './policies.mjs';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function registerSaasRoutes(app,{pool,service,requireAuth,enabled,env=process.env,billingAdapter=stripeAdapter}) {
  const wrap = fn => async(req,res)=>{
    if (!enabled()) return res.status(503).json({error:'saas_not_enabled'});
    try { await fn(req,res); }
    catch(e) { res.status(e instanceof AccessError?e.status:503).json({error:e instanceof AccessError?e.code:'account_service_unavailable'}); }
  };
  app.get('/api/billing/catalog',async(_req,res)=>{
    try { const plans=(await pool.query('SELECT * FROM ysong_plans WHERE public_visible=true ORDER BY upgrade_order')).rows;
      res.json({enabled:enabled(),plans:plans.map(p=>publicPlan(p,env.BILLING_MODE,enabled()))});
    }catch{res.status(503).json({error:'catalog_not_configured'});}
  });
  app.get('/api/billing/account',requireAuth,wrap(async(req,res)=>{
    const a=await service.account(pool,req.user.id);const plan=(await pool.query('SELECT * FROM ysong_plans WHERE id=$1',[a.plan_id])).rows[0];
    res.json({status:a.subscription_status,plan:publicPlan(plan,env.BILLING_MODE,enabled()),periodStart:a.period_start,periodEnd:a.period_end,cancellationScheduled:a.cancel_at_period_end,
      portalAvailable:!!a.billing_customer_id,usage:await service.summary(req.user.id,req.user.issuedAt)});
  }));
  app.post('/api/billing/portal',requireAuth,wrap(async(req,res)=>{
    const {stripe,live}=billingAdapter(env);const a=await service.account(pool,req.user.id);
    if(!a.billing_customer_id||a.billing_live!==live)throw new AccessError('billing_customer_not_linked',409);
    let url;try{url=new URL(env.BILLING_RETURN_URL);}catch{throw new AccessError('billing_not_configured',503);}
    if(url.protocol!=='https:'&&!(env.BILLING_MODE==='test'&&url.hostname==='localhost'))throw new AccessError('billing_not_configured',503);
    const session=await stripe.billingPortal.sessions.create({customer:a.billing_customer_id,return_url:url.href,...(env.STRIPE_PORTAL_CONFIGURATION_ID?{configuration:env.STRIPE_PORTAL_CONFIGURATION_ID}:{})});res.json({url:session.url});
  }));
  app.get('/api/account/entitlements',requireAuth,async(req,res)=>{
    if (!enabled()) return res.json({enabled:false});
    return wrap(async(r,s)=>s.json({enabled:true,...await service.summary(r.user.id,r.user.issuedAt)}))(req,res);
  });
  app.get('/api/billing/plans',requireAuth,wrap(async(_req,res)=>{
    const mode=env.BILLING_MODE==='live'?'live':'test';
    const rows=(await pool.query('SELECT id,name,monthly_generation_quota,capabilities FROM ysong_plans WHERE billing_prices->>$1 IS NOT NULL AND monthly_generation_quota IS NOT NULL',[`stripe:${mode}`])).rows;
    res.json({plans:rows});
  }));
  app.get('/api/generations/history',requireAuth,wrap(async(req,res)=>{
    const rows=(await pool.query(`SELECT b.id AS batch_id,b.quantity,b.source,b.parent_generation_id,v.* FROM ysong_generation_batches b
      JOIN ysong_generation_versions v ON v.batch_id=b.id WHERE b.user_id=$1 ORDER BY b.created_at DESC,v.version_index LIMIT 200`,[req.user.id])).rows;
    res.json({generations:rows});
  }));
  app.post('/api/generations/:id/feedback',requireAuth,wrap(async(req,res)=>{
    if (!uuid.test(req.params.id) || ![null,1,-1].includes(req.body?.feedback)) throw new AccessError('invalid_feedback',400);
    const rows=(await pool.query('UPDATE ysong_generation_versions SET feedback=$3,updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING id,feedback',[req.params.id,req.user.id,req.body.feedback])).rows;
    if (!rows.length) throw new AccessError('generation_not_found',404);
    res.json(rows[0]);
  }));
  // Queued cancellation only: never refund a started or usable generation on client claims.
  app.post('/api/generations/:id/cancel',requireAuth,wrap(async(req,res)=>{
    if (!uuid.test(req.params.id)) throw new AccessError('generation_not_found',404);
    const result=await service.transaction(async c=>{
      const v=(await c.query('SELECT * FROM ysong_generation_versions WHERE id=$1 AND user_id=$2 FOR UPDATE',[req.params.id,req.user.id])).rows[0];
      if (!v) throw new AccessError('generation_not_found',404);
      if (v.state==='cancelled') return v;
      if (v.state!=='queued') throw new AccessError('generation_already_started',409);
      const b=(await c.query('SELECT * FROM ysong_generation_batches WHERE id=$1',[v.batch_id])).rows[0];
      if (b.charged) await c.query('UPDATE ysong_quota_periods SET reserved=reserved-1 WHERE id=$1',[b.quota_period_id]);
      return (await c.query("UPDATE ysong_generation_versions SET state='cancelled',reconciliation='released',updated_at=now() WHERE id=$1 RETURNING *",[v.id])).rows[0];
    }); res.json(result);
  }));
  async function admin(req) {
    const a=await service.account(pool,req.user.id);
    if (!a || a.account_status!=='active' || !['admin','superadmin'].includes(a.role)) throw new AccessError('admin_required');
  }
  app.get('/api/admin/accounts',requireAuth,wrap(async(req,res)=>{
    await admin(req); const query=String(req.query.q??'').slice(0,100);
    res.json({accounts:(await pool.query(`SELECT u.id,u.email,u.display_name,a.role,a.account_status,a.plan_id,a.subscription_status,
      a.override_plan_id,a.override_quota,a.override_expires_at,a.generation_disabled,a.uploads_disabled
      FROM users u LEFT JOIN ysong_account_access a ON a.user_id=u.id WHERE u.email::text ILIKE $1 OR u.display_name ILIKE $1 ORDER BY u.created_at DESC LIMIT 50`,[`%${query}%`])).rows});
  }));
  app.post('/api/admin/accounts/:id/actions',requireAuth,wrap(async(req,res)=>{
    if (!uuid.test(req.params.id)) throw new AccessError('account_not_found',404);
    res.json(await service.adminAction(req.user.id,req.params.id,req.body?.action,req.body?.value,req.body?.reason));
  }));
  app.get('/api/admin/accounts/:id/usage',requireAuth,wrap(async(req,res)=>{
    await admin(req);if(!uuid.test(req.params.id))throw new AccessError('account_not_found',404);
    const account=await service.account(pool,req.params.id);if(!account)throw new AccessError('account_not_found',404);
    const periods=(await pool.query('SELECT starts_at,ends_at,used,reserved FROM ysong_quota_periods WHERE user_id=$1 ORDER BY starts_at DESC LIMIT 12',[req.params.id])).rows;
    const events=(await pool.query('SELECT id,request_key,capability,provider,model,units,reported_cost,admin_exempt,state,created_at FROM ysong_usage_events WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',[req.params.id])).rows;
    res.json({periods,events});
  }));
  app.get('/api/admin/audit',requireAuth,wrap(async(req,res)=>{
    await admin(req); res.json({actions:(await pool.query('SELECT * FROM ysong_admin_audit ORDER BY created_at DESC LIMIT 100')).rows});
  }));
  app.post('/api/admin/providers/:id',requireAuth,wrap(async(req,res)=>{
    await admin(req);
    if (typeof req.body?.enabled!=='boolean' || typeof req.body?.reason!=='string' || req.body.reason.trim().length<3 || req.body.reason.length>2000) throw new AccessError('invalid_provider_control',400);
    await service.transaction(async c=>{
      const before=(await c.query('SELECT * FROM ysong_provider_controls WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
      if (!before) throw new AccessError('provider_not_found',404);
      await c.query('UPDATE ysong_provider_controls SET enabled=$2,updated_at=now() WHERE id=$1',[before.id,req.body.enabled]);
      await c.query('INSERT INTO ysong_admin_audit(id,actor_id,action,reason,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6)',[crypto.randomUUID(),req.user.id,'provider_control',req.body.reason,{provider:before.id,enabled:before.enabled},{provider:before.id,enabled:req.body.enabled}]);
    }); res.json({updated:true});
  }));
  app.post('/api/billing/checkout',requireAuth,wrap(async(req,res)=>{
    const planId=req.body?.planId;
    if (!['basic','pro','premium'].includes(planId)) throw new AccessError('invalid_plan',400);
    const key=req.get('idempotency-key') ?? req.body?.requestKey;
    if (typeof key!=='string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(key)) throw new AccessError('invalid_request_key',400);
    const access=await service.access(req.user.id,req.user.issuedAt);
    if (access.superadmin) throw new AccessError('superadmin_does_not_need_checkout',409);
      const policies=(await pool.query("SELECT p.*,a.accepted_at FROM ysong_policy_versions p LEFT JOIN ysong_policy_acceptances a ON a.policy_id=p.policy_id AND a.version=p.version AND a.user_id=$1 WHERE p.active AND p.policy_id IN ('terms','privacy','billing')",[req.user.id])).rows;
      if(policies.length!==3||policies.some(p=>!approvedPolicy(p)))throw new AccessError('billing_policies_not_configured',503);
      if(policies.some(p=>!p.accepted_at))throw new AccessError('policy_acceptance_required',403);
    const {stripe,live}=billingAdapter(env);
    const plan=(await pool.query('SELECT * FROM ysong_plans WHERE id=$1',[planId])).rows[0];
    const price=plan?.billing_prices?.[`stripe:${live?'live':'test'}`];
    if (!plan?.available || !price || plan.monthly_generation_quota===null || plan.capabilities?.generation!==true) throw new AccessError('billing_price_not_configured',503);
      const product=plan.billing_products?.[`stripe:${live?'live':'test'}`];
      if(live&&!product)throw new AccessError('billing_product_not_configured',503);
    const configuredPrice=await stripe.prices.retrieve(price);
    if(!configuredPrice.active||configuredPrice.livemode!==live||configuredPrice.currency!==plan.currency||configuredPrice.unit_amount!==plan.monthly_price_cents||configuredPrice.recurring?.interval!==plan.billing_interval)throw new AccessError('billing_price_catalog_mismatch',503);
      if(product&&product!==(typeof configuredPrice.product==='string'?configuredPrice.product:configuredPrice.product?.id))throw new AccessError('billing_product_catalog_mismatch',503);
    let base; try {base=new URL(env.BILLING_RETURN_URL);} catch {throw new AccessError('billing_not_configured',503);}
    if (base.protocol!=='https:' && !(env.BILLING_MODE==='test' && base.hostname==='localhost')) throw new AccessError('billing_not_configured',503);
      const redirect=value=>{let url;try{url=new URL(value);}catch{throw new AccessError('billing_redirect_not_configured',503);}if(url.origin!==base.origin||url.username||url.password)throw new AccessError('billing_redirect_origin_mismatch',503);return url.href;};
      const successUrl=redirect(env.BILLING_SUCCESS_URL||new URL('?billing=success',base).href),cancelUrl=redirect(env.BILLING_CANCEL_URL||new URL('?billing=cancelled',base).href);
    const customer=await service.transaction(async c=>{
      const a=await service.account(c,req.user.id,true);
      if (a.billing_subscription_id && ['active','trialing','past_due','unpaid','incomplete'].includes(a.subscription_status)) throw new AccessError('subscription_already_exists',409);
      if (a.billing_customer_id && a.billing_live!==live) throw new AccessError('billing_mode_mismatch',409);
      if (a.billing_customer_id) return a.billing_customer_id;
      const created=await stripe.customers.create({metadata:{ysong_user_id:req.user.id}},{idempotencyKey:`ysong-customer-${live}-${req.user.id}`});
      await c.query("UPDATE ysong_account_access SET billing_provider='stripe',billing_live=$2,billing_customer_id=$3,updated_at=now() WHERE user_id=$1",[req.user.id,live,created.id]);
      return created.id;
    });
    const pending=await service.transaction(async c=>{
      const a=await service.account(c,req.user.id,true);
      if(a.billing_subscription_id&&['active','trialing','past_due','unpaid','incomplete'].includes(a.subscription_status))throw new AccessError('subscription_already_exists',409);
      const previous=(await c.query('SELECT * FROM ysong_checkout_attempts WHERE user_id=$1 FOR UPDATE',[req.user.id])).rows[0];
      if(previous&&new Date(previous.expires_at)>new Date()){
        if(previous.request_key!==key)throw new AccessError('checkout_already_pending',409);
        if(previous.plan_id!==planId)throw new AccessError('idempotency_conflict',409);return previous;
      }
      return (await c.query("INSERT INTO ysong_checkout_attempts(user_id,request_key,plan_id,expires_at) VALUES($1,$2,$3,now()+interval '1 hour') ON CONFLICT(user_id) DO UPDATE SET request_key=excluded.request_key,plan_id=excluded.plan_id,expires_at=excluded.expires_at,session_id=NULL,url=NULL RETURNING *",[req.user.id,key,planId])).rows[0];
    });
    if(pending.url)return res.json({url:pending.url});
    const checkout=await stripe.checkout.sessions.create({mode:'subscription',customer,line_items:[{price,quantity:1}],expires_at:Math.floor(new Date(pending.expires_at).getTime()/1000),
      success_url:successUrl,cancel_url:cancelUrl,
      client_reference_id:req.user.id},{idempotencyKey:`ysong-checkout-${req.user.id}-${key}`});
    // Checkout dynamic payment methods expose Link when enabled and eligible in Stripe.
    await pool.query('UPDATE ysong_checkout_attempts SET session_id=$3,url=$4 WHERE user_id=$1 AND request_key=$2',[req.user.id,key,checkout.id,checkout.url]);
    res.json({url:checkout.url});
  }));
}

// Central presentation-independent gate. No reservations until a validated executor owns the work.
export function createAccessGate({service,requireAuth,enabled}) {
  return (req,res,next)=>{
    if (!enabled()) return next();
    const upload=req.method==='POST' && ['/api/uploads','/api/uploads/copy'].includes(req.path);
    const ai=req.method==='POST' && (req.path==='/chat' || /^\/api\/(?:music\/generate|artwork\/generate|composer\/|sound-designer\/|stem-composer\/|critique\/ai-summary|rooms\/[^/]+\/ai\/respond)/.test(req.path));
    if (!upload && !ai) return next();
    requireAuth(req,res,async()=>{
      try {
        const entitlement=await service.access(req.user.id,req.user.issuedAt);
        const capability=upload?'uploads':req.path==='/chat'||req.path.includes('/ai/respond')||req.path.includes('/critique/')?'assistant':req.path.includes('/artwork/')?'artwork':'generation';
        assertCapability(entitlement,capability);
        if (ai) {
          await service.providerEnabled('global');
          if (req.path!=='/api/music/generate') await service.providerEnabled(req.path.includes('/artwork/') ? String(process.env.ARTWORK_AI_PROVIDER||'openai') : 'openai');
          // Quota integration for these executors is still pending. Fail closed for
          // normal accounts instead of letting paid generation bypass reservation.
          if (['generation','artwork'].includes(capability) && req.path!=='/api/music/generate' && !entitlement.superadmin)
            throw new AccessError('generation_executor_not_integrated',503);
        }
        next();
      } catch(e) {res.status(e instanceof AccessError?e.status:503).json({error:e instanceof AccessError?e.code:'account_service_unavailable'});}
    });
  };
}
