import Stripe from 'stripe';
import crypto from 'node:crypto';
import {billingWebhookEvents} from './billing.mjs';

export const webhookManualBlocker = 'Confirm the HTTPS URL reaches the Express billing owner at /api/billing/webhook; supply BILLING_MODE=test and an explicit sk_test_ STRIPE_SECRET_KEY plus STRIPE_TEST_WEBHOOK_URL. Run --check, then --apply-test-mode to create if missing. In the matching Stripe test sandbox, securely copy this endpoint signing secret into STRIPE_WEBHOOK_SECRET; set BILLING_WEBHOOK_ENABLED=1 only on the isolated test backend, keep SAAS_ENABLED=0, and verify signed lifecycle deliveries. This utility never prints or stores signing secrets.';

// Deliberately no dotenv: an operator must select the sandbox credentials explicitly.
export async function configureStripeTestWebhook({env=process.env,applyTestMode=false,
  createClient=key=>new Stripe(key,{timeout:20000,maxNetworkRetries:2})}={}) {
  const key=env.STRIPE_SECRET_KEY;
  if (env.BILLING_MODE && env.BILLING_MODE !== 'test') throw new Error('Test mode required.');
  if (key && !/^sk_test_\S+$/.test(key)) throw new Error('Test key required.');
  if (env.SAAS_ENABLED && env.SAAS_ENABLED !== '0') throw new Error('Keep SaaS off.');
  const address=env.STRIPE_TEST_WEBHOOK_URL;
  let url;
  if (address) {
    url=new URL(address);
    if (url.protocol!=='https:' || url.username || url.password || url.search || url.hash || url.pathname!=='/api/billing/webhook') throw new Error('Exact HTTPS webhook URL required.');
  }
  const result={mode:'test',status:'offline',route:'/api/billing/webhook',url:url?.href??null,
    enabledEvents:[...billingWebhookEvents],endpointId:null,action:'configuration-required',manualBlocker:webhookManualBlocker};
  if (!key || !url || env.BILLING_MODE!=='test') {
    if (applyTestMode) throw new Error('Explicit test configuration required.');
    return result;
  }
  const stripe=createClient(key),matches=[];
  for await (const endpoint of stripe.webhookEndpoints.list({limit:100})) {
    if (endpoint.livemode!==false) throw new Error('Non-test endpoint returned.');
    if (endpoint.url===url.href) matches.push(endpoint);
  }
  if(matches.length>1) throw new Error('Duplicate endpoints require manual review.');
  const valid = endpoint => endpoint.livemode===false && endpoint.url===url.href && endpoint.status==='enabled' &&
    endpoint.enabled_events?.length===billingWebhookEvents.length && billingWebhookEvents.every(e=>endpoint.enabled_events.includes(e)) && !endpoint.application;
  let endpoint=matches[0];
  if (endpoint && !valid(endpoint)) throw new Error('Endpoint configuration conflict requires manual review.');
  result.action=endpoint?'reuse':'create';
  if (!endpoint && applyTestMode) {
    endpoint=await stripe.webhookEndpoints.create({url:url.href,enabled_events:[...billingWebhookEvents],
      description:'YSong test billing owner',metadata:{ysong_owner:'billing',ysong_mode:'test'}},
      {idempotencyKey:'ysong:test:webhook:v1:'+crypto.createHash('sha256').update(url.href).digest('hex')});
    if (!valid(endpoint)) throw new Error('Created endpoint failed validation.');
  }
  // Whitelist output fields; never return the SDK object (create includes a secret).
  result.endpointId=endpoint?.id??null;
  result.status=applyTestMode?'applied':'checked';
  return result;
}
