import {configureStripeTestWebhook,webhookManualBlocker} from '../src/saas/stripe-webhook-test.mjs';

try {
  const args=process.argv.slice(2);
  if(args.length>1 || args.some(a=>!['--check','--dry-run','--apply-test-mode'].includes(a))) throw new Error('Invalid arguments.');
  console.log(JSON.stringify(await configureStripeTestWebhook({applyTestMode:args.includes('--apply-test-mode')}),null,2));
} catch {
  console.error('Stripe TEST webhook check failed. Review arguments, explicit test credentials, URL, permissions, and duplicate/disabled/conflicting endpoints in the test Dashboard. No credential details displayed.');
  console.error(webhookManualBlocker);
  process.exitCode=1;
}
