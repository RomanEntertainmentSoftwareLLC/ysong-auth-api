import 'dotenv/config';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import pg from 'pg';
import {validateLaunchConfiguration,applyLaunchConfiguration} from '../src/saas/configuration.mjs';
import {stripeAdapter} from '../src/saas/billing.mjs';
try {
const args=process.argv.slice(2),file=args[args.indexOf('--file')+1];
if(!args.includes('--file')||!file)throw new Error('Provide --file with reviewed JSON; default operation validates only.');
const c=validateLaunchConfiguration(JSON.parse(await fs.readFile(file,'utf8')));
if(!args.includes('--apply')){console.log('Configuration structure checked; no database/provider calls. Approval references require human verification.');}
else {
  if(process.env.SAAS_ENABLED==='1'||!process.env.DATABASE_URL||new URL(process.env.DATABASE_URL).hostname!==c.databaseHost)throw new Error('Keep SaaS disabled and explicitly match the intended database host.');
  if(process.env.BILLING_MODE!==c.mode)throw new Error('Configuration billing mode differs from the server mode.');
  const {stripe,live}=stripeAdapter();const amounts={basic:999,pro:1999,premium:2999};
  for(const p of c.plans.filter(p=>p.id!=='free')){const price=await stripe.prices.retrieve(p.priceId);if(!price.active||price.livemode!==live||price.currency!=='usd'||price.unit_amount!==amounts[p.id]||price.recurring?.interval!=='month'||(typeof price.product==='string'?price.product:price.product?.id)!==p.productId)throw new Error('Configured Stripe catalog does not match the intended mode/product/monthly price.');}
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSL==='0'?false:{rejectUnauthorized:false}}),client=await pool.connect();
  try{await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtext('ysong-saas-configuration'))");await applyLaunchConfiguration(client,c);await client.query('INSERT INTO ysong_admin_audit(id,actor_id,action,reason,after_state) VALUES($1,$2,$3,$4,$5)',[crypto.randomUUID(),c.superadminUserId,'launch_configuration','Owner-reviewed billing/plan configuration and recorded legal approval references',{mode:c.mode,plans:c.plans.map(p=>p.id),policies:c.policies.map(p=>({id:p.id,version:p.version}))}]);await client.query('COMMIT');console.log('Reviewed configuration applied; SaaS remains disabled.');}
  catch{await client.query('ROLLBACK');throw new Error('Configuration was not applied; transaction rolled back.');}
  finally{client.release();await pool.end();}
}
} catch {console.error('Launch configuration failed: supply complete reviewed configuration, verify target/mode and prerequisites. No credential details displayed.');process.exitCode=1;}
