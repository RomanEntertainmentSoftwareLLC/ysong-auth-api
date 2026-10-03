import {z} from 'zod';
const id=z.enum(['free','basic','pro','premium']);
const version=z.string().min(3).max(120).refine(v=>!/draft|placeholder|attorney.review.required/i.test(v));
const schema=z.object({
  mode:z.enum(['test','live']),databaseHost:z.string().min(3),superadminUserId:z.string().uuid(),
  plans:z.array(z.object({id,quota:z.number().int().nonnegative(),storageQuotaBytes:z.number().int().nonnegative().nullable(),capabilities:z.object({generation:z.boolean(),assistant:z.boolean(),uploads:z.boolean(),artwork:z.literal(false)}).strict(),assistantLimit:z.number().int().nonnegative().nullable(),available:z.boolean(),priceId:z.string().startsWith('price_').nullable(),productId:z.string().startsWith('prod_').nullable()}).strict()).length(4),
  policies:z.array(z.object({id:z.enum(['terms','privacy','upload-rights','billing','generated-output','bridge-license']),version,url:z.string().url().refine(v=>new URL(v).protocol==='https:'),approvalReference:z.string().min(10).max(500)}).strict()).length(6)
}).strict();
export function validateLaunchConfiguration(input){
  const result=schema.safeParse(input);if(!result.success)throw new Error('Launch configuration requires complete owner-reviewed plan and legal values.');const c=result.data;
  if(new Set(c.plans.map(p=>p.id)).size!==4||new Set(c.policies.map(p=>p.id)).size!==6)throw new Error('Each canonical plan and policy must be configured exactly once.');
  const paid=c.plans.filter(p=>p.id!=='free');if(paid.some(p=>!p.priceId||!p.productId)||new Set(paid.map(p=>p.priceId)).size!==3)throw new Error('Distinct configured paid price references and product references are required.');
  if(c.plans.find(p=>p.id==='free').priceId||c.plans.find(p=>p.id==='free').productId)throw new Error('Free must not create a Stripe subscription.');
  if(c.plans.some(p=>p.capabilities.assistant&&p.assistantLimit===null))throw new Error('Assistant features require an explicit request allowance.');
  if(c.plans.some(p=>p.available&&(!p.capabilities.generation||p.quota===0)))throw new Error('Available plans require explicit generation access and a positive allowance.');return c;
}
export async function applyLaunchConfiguration(client,c){
  const expected={free:0,basic:999,pro:1999,premium:2999},catalog=(await client.query('SELECT id,monthly_price_cents,currency,billing_interval FROM ysong_plans')).rows;
  if(catalog.length!==4||catalog.some(p=>!Object.hasOwn(expected,p.id)||p.monthly_price_cents!==expected[p.id]||p.currency!=='usd'||p.billing_interval!=='month'))throw new Error('Review the canonical intended monthly price catalog before configuration.');
  if(!(await client.query("SELECT 1 FROM ysong_account_access WHERE user_id=$1 AND role='superadmin' AND account_status='active'",[c.superadminUserId])).rows.length)throw new Error('Configured immutable superadmin identity does not match the migrated database.');
  for(const p of c.plans){await client.query('UPDATE ysong_plans SET monthly_generation_quota=$2,storage_quota_bytes=$3,capabilities=$4,usage_limits=$5,available=$6,billing_prices=billing_prices||$7::jsonb,billing_products=billing_products||$8::jsonb,updated_at=now() WHERE id=$1',[p.id,p.quota,p.storageQuotaBytes,p.capabilities,p.assistantLimit===null?{}:{assistant:p.assistantLimit},p.available,p.priceId?{[`stripe:${c.mode}`]:p.priceId}:{},p.productId?{[`stripe:${c.mode}`]:p.productId}:{}]);}
  for(const p of c.policies){
    const old=(await client.query('SELECT * FROM ysong_policy_versions WHERE policy_id=$1 AND version=$2',[p.id,p.version])).rows[0];
    if(old&&(old.url!==p.url||!old.approved||old.approval_reference!==p.approvalReference))throw new Error('Published policy versions are immutable; create a new reviewed version.');
    await client.query('UPDATE ysong_policy_versions SET active=false WHERE policy_id=$1 AND active',[p.id]);
    await client.query('INSERT INTO ysong_policy_versions(policy_id,version,url,approved,required,active,approval_reference) VALUES($1,$2,$3,true,true,true,$4) ON CONFLICT(policy_id,version) DO UPDATE SET active=true',[p.id,p.version,p.url,p.approvalReference]);
  }
}
