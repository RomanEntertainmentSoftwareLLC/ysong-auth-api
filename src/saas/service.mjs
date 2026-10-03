import crypto from 'node:crypto';
import {notifySaas} from './notifications.mjs';
export class AccessError extends Error {
  constructor(code, status = 403) { super(code); this.code = code; this.status = status; }
}
export function quantityOf(value = 1) {
  if (!Number.isInteger(value) || value < 1 || value > 20) throw new AccessError('invalid_quantity', 400);
  return value;
}
export function effectiveEntitlement(account, plans, now = new Date()) {
  if (!account) throw new AccessError('account_not_found', 401);
  const superadmin = account.role === 'superadmin';
  const overridden = !!account.override_plan_id && (!account.override_expires_at || new Date(account.override_expires_at) > now);
  const subscribed = ['active', 'trialing'].includes(account.subscription_status) && account.period_end && new Date(account.period_end) > now;
  const planId = overridden ? account.override_plan_id : subscribed ? account.plan_id : 'free';
  const plan = plans.find(p => p.id === planId);
  if (!plan) throw new AccessError('plan_not_configured', 503);
  return { planId, name: superadmin ? 'Superadmin' : plan.name, superadmin, admin: ['admin','superadmin'].includes(account.role),
    quota: superadmin ? null : overridden && account.override_quota !== null ? account.override_quota : plan.monthly_generation_quota,
    capabilities: superadmin ? { generation: true, assistant: true, artwork: true, uploads: true } : {
      ...plan.capabilities, ...(overridden ? account.override_capabilities : {}) },
    status: account.account_status, generationDisabled: account.generation_disabled, uploadsDisabled: account.uploads_disabled };
}
export function assertCapability(entitlement, capability) {
  if (entitlement.status !== 'active') throw new AccessError(`account_${entitlement.status}`);
  if (capability === 'generation' && entitlement.generationDisabled) throw new AccessError('generation_disabled');
  if (capability === 'uploads' && entitlement.uploadsDisabled) throw new AccessError('uploads_disabled');
  if (!entitlement.superadmin && entitlement.capabilities[capability] !== true) throw new AccessError('plan_restricted');
}
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createSaasService(pool) {
  async function transaction(fn) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const result = await fn(c); await c.query('COMMIT'); return result; }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  async function account(c, userId, lock = false) {
    await c.query('INSERT INTO ysong_account_access(user_id) SELECT id FROM users WHERE id=$1 ON CONFLICT DO NOTHING', [userId]);
    return (await c.query(`SELECT * FROM ysong_account_access WHERE user_id=$1${lock ? ' FOR UPDATE' : ''}`, [userId])).rows[0];
  }
  async function entitlement(c, a) { return effectiveEntitlement(a, (await c.query('SELECT * FROM ysong_plans')).rows); }
  async function access(userId, issuedAt) {
    const a = await account(pool, userId);
    if (a?.sessions_revoked_before && (!issuedAt || issuedAt * 1000 <= new Date(a.sessions_revoked_before).getTime())) throw new AccessError('session_revoked', 401);
    const e = await entitlement(pool, a);
    if (e.status !== 'active') throw new AccessError(`account_${e.status}`);
    return e;
  }
  async function providerEnabled(provider) {
    const rows = (await pool.query("SELECT id,enabled FROM ysong_provider_controls WHERE id=ANY($1)", [['global', provider]])).rows;
    if (!rows.find(r => r.id === 'global')?.enabled || !rows.find(r => r.id === provider)?.enabled) throw new AccessError('generation_maintenance', 503);
  }
  async function reserve(userId, input) {
    const quantity = quantityOf(input.quantity);
    if (typeof input.requestKey !== 'string' || input.requestKey.length < 8 || input.requestKey.length > 128) throw new AccessError('invalid_request_key', 400);
    if (!input.source || typeof input.source !== 'object' || JSON.stringify(input.source).length > 200000) throw new AccessError('invalid_generation_source', 400);
    // Caller owns source construction; plan/remaining/quota claims have no role here.
    const hash = digest({ quantity, source: input.source, parentId: input.parentId ?? null });
    return transaction(async c => {
      const a = await account(c, userId, true); const e = await entitlement(c, a); assertCapability(e, 'generation');
      const previous = (await c.query('SELECT * FROM ysong_generation_batches WHERE user_id=$1 AND request_key=$2', [userId, input.requestKey])).rows[0];
      if (previous) {
        if (previous.request_hash !== hash) throw new AccessError('idempotency_conflict', 409);
        return { batch: previous, versions: (await c.query('SELECT * FROM ysong_generation_versions WHERE batch_id=$1 ORDER BY version_index', [previous.id])).rows, replay: true };
      }
      if (input.parentId && !(await c.query('SELECT id FROM ysong_generation_versions WHERE id=$1 AND user_id=$2', [input.parentId,userId])).rows.length) throw new AccessError('parent_not_found',404);
      let period = null;
      if (!e.superadmin) {
        if (e.quota === null || e.quota === undefined) throw new AccessError('quota_not_configured', 503);
        // UTC calendar month: late reconciliation always addresses its original period.
        const current = new Date(); const start = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1));
        const end = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1));
        await c.query('INSERT INTO ysong_quota_periods(id,user_id,starts_at,ends_at) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,starts_at) DO NOTHING', [crypto.randomUUID(),userId,start,end]);
        period = (await c.query('UPDATE ysong_quota_periods SET reserved=reserved+$3 WHERE user_id=$1 AND starts_at=$2 AND used+reserved+$3 <= $4 RETURNING *', [userId,start,quantity,e.quota])).rows[0];
        if (!period) throw new AccessError('quota_exhausted', 409);
      }
      const id = crypto.randomUUID();
      const batch = (await c.query('INSERT INTO ysong_generation_batches(id,user_id,request_key,request_hash,quantity,source,parent_generation_id,quota_period_id,charged) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [id,userId,input.requestKey,hash,quantity,input.source,input.parentId??null,period?.id??null,!e.superadmin])).rows[0];
      const versions = [];
      for (let index = 1; index <= quantity; index++) versions.push((await c.query('INSERT INTO ysong_generation_versions(id,batch_id,user_id,project_id,version_index) VALUES($1,$2,$3,$4,$5) RETURNING *', [crypto.randomUUID(),id,userId,crypto.randomUUID(),index])).rows[0]);
      return { batch, versions, replay: false };
    });
  }
  // Server executor only. No route accepts client assertions of success/failure/refund.
  async function reconcile(versionId, outcome, result = null, errorCode = null, execution = null) {
    if (!['ready','partially_ready','failed','cancelled'].includes(outcome)) throw new AccessError('invalid_outcome',400);
    return transaction(async c => {
      const v = (await c.query('SELECT * FROM ysong_generation_versions WHERE id=$1 FOR UPDATE', [versionId])).rows[0];
      if (!v) throw new AccessError('generation_not_found',404);
      if (v.reconciliation !== 'reserved') {
        // A partial version's safe component retry consumes no second unit.
        if (v.reconciliation === 'consumed' && ['ready','partially_ready'].includes(outcome)) return (await c.query('UPDATE ysong_generation_versions SET state=$2,result=$3,error_code=$4,execution=COALESCE($5,execution),updated_at=now() WHERE id=$1 RETURNING *',[versionId,outcome,result,errorCode,execution])).rows[0];
        return v;
      }
      const usable = outcome === 'ready' || outcome === 'partially_ready';
      await notifySaas(c,v.user_id,`generation:${v.id}:${outcome}`,outcome==='ready'?'Generation ready':outcome==='partially_ready'?'Generation partially completed':'Generation did not complete',usable?'Open generation history to review the saved result.':'Review generation history before retrying.','/app?view=createSong');
      const b = (await c.query('SELECT * FROM ysong_generation_batches WHERE id=$1', [v.batch_id])).rows[0];
      if (b.charged) await c.query('UPDATE ysong_quota_periods SET reserved=reserved-1,used=used+$2 WHERE id=$1', [b.quota_period_id,usable?1:0]);
      return (await c.query('UPDATE ysong_generation_versions SET state=$2,reconciliation=$3,result=$4,error_code=$5,execution=COALESCE($6,execution),updated_at=now() WHERE id=$1 RETURNING *', [versionId,outcome,usable?'consumed':'released',result,errorCode,execution])).rows[0];
    });
  }
  async function start(versionId, provider, model) {
    await providerEnabled(provider);
    const v = (await pool.query("UPDATE ysong_generation_versions SET state='generating',provider=$2,model=$3,updated_at=now() WHERE id=$1 AND state='queued' RETURNING *", [versionId,provider,model])).rows[0];
    if (!v) throw new AccessError('generation_already_started',409);
    return v;
  }
  async function summary(userId, issuedAt) {
    const e = await access(userId, issuedAt); const usage = (await pool.query('SELECT used,reserved,ends_at FROM ysong_quota_periods WHERE user_id=$1 AND starts_at<=now() AND ends_at>now()', [userId])).rows[0];
    return { ...e, used: usage?.used ?? 0, reserved: usage?.reserved ?? 0, resetAt: usage?.ends_at ?? null,
      remaining: e.quota === null ? null : Math.max(0,e.quota-(usage?.used??0)-(usage?.reserved??0)) };
  }
  async function adminAction(actorId,targetId,action,value,reason) {
    if (typeof reason !== 'string' || reason.trim().length < 3 || reason.length > 2000) throw new AccessError('reason_required',400);
    return transaction(async c => {
      // Serialize admin operations by actor/target in deterministic order to avoid reciprocal deadlocks.
      for (const id of [...new Set([actorId,targetId])].sort()) await account(c,id,true);
      const actor = await account(c,actorId); const before = await account(c,targetId);
      if (!actor || actor.account_status !== 'active' || !['admin','superadmin'].includes(actor.role)) throw new AccessError('admin_required');
      if (!before) throw new AccessError('account_not_found',404);
      if (before.role === 'superadmin' || (before.role === 'admin' && actor.role !== 'superadmin')) throw new AccessError('protected_account');
      const columns = { suspend: 'account_status', ban: 'account_status', unban: 'account_status', generation: 'generation_disabled', uploads: 'uploads_disabled' };
      if (columns[action]) {
        const next = { suspend:'suspended', ban:'banned', unban:'active' }[action] ?? value;
        if (['generation','uploads'].includes(action) && typeof next !== 'boolean') throw new AccessError('invalid_action',400);
        await c.query(`UPDATE ysong_account_access SET ${columns[action]}=$2,updated_at=now() WHERE user_id=$1`, [targetId,next]);
      } else if (action === 'revoke_sessions') await c.query('UPDATE ysong_account_access SET sessions_revoked_before=now(),updated_at=now() WHERE user_id=$1',[targetId]);
      else if (action === 'override') {
        if (value?.planId !== null && !['free','basic','pro','premium'].includes(value?.planId)) throw new AccessError('invalid_plan',400);
        if (value.quota != null && (!Number.isInteger(value.quota) || value.quota < 0)) throw new AccessError('invalid_quota',400);
        if (value.expiresAt && !Number.isFinite(Date.parse(value.expiresAt))) throw new AccessError('invalid_expiry',400);
        await c.query('UPDATE ysong_account_access SET override_plan_id=$2,override_quota=$3,override_expires_at=$4,override_reason=$5,updated_at=now() WHERE user_id=$1',[targetId,value.planId,value.quota??null,value.expiresAt??null,reason]);
      } else if (action !== 'note') throw new AccessError('invalid_action',400);
      const after = await account(c,targetId);
      const safe = a => ({ role:a.role, status:a.account_status, plan:a.plan_id, overridePlan:a.override_plan_id, overrideQuota:a.override_quota, overrideExpiresAt:a.override_expires_at, generationDisabled:a.generation_disabled, uploadsDisabled:a.uploads_disabled, sessionsRevokedBefore:a.sessions_revoked_before });
      await c.query('INSERT INTO ysong_admin_audit(id,actor_id,target_id,action,reason,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6,$7)',[crypto.randomUUID(),actorId,targetId,action,reason.trim(),safe(before),safe(after)]);
      if(['suspend','ban','unban'].includes(action))await notifySaas(c,targetId,`account:${targetId}:${action}:${after.updated_at.toISOString()}`,'Account access updated',`Your account status is ${after.account_status}. Contact YSong support for review.`);
      return safe(after);
    });
  }
  async function acquireRender(versionId) {
    const c=await pool.connect();
    try {if(!(await c.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[versionId])).rows[0].locked)throw new AccessError('render_executor_active',409);}
    catch(e){c.release();throw e;}
    return async()=>{try{await c.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[versionId]);c.release();}catch(e){c.release(true);throw e;}};
  }
  return { transaction, account, access, summary, providerEnabled, reserve, start, reconcile, adminAction, acquireRender };
}
