export function environmentGates(env){
 const key=env.STRIPE_SECRET_KEY;
 return [
  {gate:'SaaS remains disabled',status:env.SAAS_ENABLED==='0'?'PASS':env.SAAS_ENABLED==='1'?'FAIL':'NOT CONFIGURED',detail:'Explicit disabled flag required'},
  {gate:'Production billing mode/key',status:!key||!env.BILLING_MODE?'NOT CONFIGURED':env.BILLING_MODE==='live'&&key.startsWith('sk_live_')?'PASS':'FAIL',detail:'Live key must match live mode; no values displayed'},
  {gate:'Webhook signing secret',status:!env.STRIPE_WEBHOOK_SECRET?'NOT CONFIGURED':env.STRIPE_WEBHOOK_SECRET.startsWith('whsec_')?'PASS':'FAIL',detail:'Presence only; endpoint delivery requires review'},
  {gate:'Explicit portal configuration',status:env.STRIPE_PORTAL_CONFIGURATION_ID?.startsWith('bpc_')?'PASS':'NOT CONFIGURED',detail:'Presence only; dashboard review required'},
  {gate:'Billing redirect URLs',status:redirectsReady(env)?'PASS':'NOT CONFIGURED',detail:'HTTPS success/cancel URLs must share the return origin'},
  {gate:'Pre-enablement signed webhook ingestion',status:env.BILLING_WEBHOOK_ENABLED==='1'?'PASS':env.BILLING_WEBHOOK_ENABLED==='0'?'NOT CONFIGURED':'MANUAL ACTION REQUIRED',detail:'Runtime flag presence only; delivery requires review'},
  {gate:'Resend presence',status:env.RESEND_API_KEY&&env.EMAIL_FROM?'PASS':'NOT CONFIGURED',detail:'No email sent'},
  {gate:'R2 configuration presence',status:['R2_ENDPOINT','R2_BUCKET','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY'].every(k=>env[k])?'PASS':'NOT CONFIGURED',detail:'No object changed'},
  {gate:'Generation provider configuration',status:['cloudflare','cf'].includes(String(env.MINIMAX_MUSIC_PROVIDER).toLowerCase())&&env.CLOUDFLARE_ACCOUNT_ID&&env.CLOUDFLARE_AI_API_TOKEN?'PASS':'MANUAL ACTION REQUIRED',detail:'Existing audio.cpp/HTTP remain available; no AI/music smoke call'}
 ];
}
function redirectsReady(e){try{const base=new URL(e.BILLING_RETURN_URL);return base.protocol==='https:'&&[e.BILLING_SUCCESS_URL,e.BILLING_CANCEL_URL].every(v=>{const u=new URL(v);return u.origin===base.origin&&!u.username&&!u.password;});}catch{return false;}}
export function catalogGates(plans){
 const ids=['free','basic','pro','premium'],valid=plans.length===4&&ids.every(id=>plans.some(p=>p.id===id)),paid=plans.filter(p=>p.id!=='free');
 return [
  {gate:'Plan catalog/allowances',status:valid&&plans.every(p=>Number.isInteger(p.monthly_generation_quota)&&p.monthly_generation_quota>=0)?'PASS':'NOT CONFIGURED',detail:'NULL never means unlimited'},
  {gate:'Live price/product mappings',status:valid&&paid.every(p=>p.available&&p.billing_prices?.['stripe:live']?.startsWith('price_')&&p.billing_products?.['stripe:live']?.startsWith('prod_'))&&new Set(paid.map(p=>p.billing_prices['stripe:live'])).size===3?'PASS':'NOT CONFIGURED',detail:'Stripe amount/product/mode checked before Checkout'},
  {gate:'Assistant metering configuration',status:valid&&plans.every(p=>!p.capabilities?.assistant||Number.isInteger(p.usage_limits?.assistant)&&p.usage_limits.assistant>=0)?'PASS':'NOT CONFIGURED',detail:'Explicit server monthly request limits'},
  {gate:'Existing Free account compatibility',status:plans.some(p=>p.id==='free')?'PASS':'NOT CONFIGURED',detail:'No subscription needed for account/project reads; costly features remain separately configured'}
 ];
}
export function readiness(gates){return ['FAIL','NOT CONFIGURED','MANUAL ACTION REQUIRED','PASS'].find(status=>gates.some(g=>g.status===status))??'NOT CONFIGURED';}
