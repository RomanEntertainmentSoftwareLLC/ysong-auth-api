import {bootstrapStripeTest} from '../src/saas/stripe-bootstrap.mjs';

try {
  const args=process.argv.slice(2);
  if(args.some(a=>!['--check','--dry-run','--apply-test-mode'].includes(a)) ||
    (args.includes('--apply-test-mode') && args.some(a=>a==='--check'||a==='--dry-run')))
    throw new Error('Invalid arguments.');
  const result=await bootstrapStripeTest({applyTestMode:args.includes('--apply-test-mode')});
  console.log(JSON.stringify(result,null,2));
} catch {
  // SDK error messages can contain request data. Never echo errors or environment values.
  console.error('Stripe test bootstrap failed. Check arguments, test key/mode, permissions and catalog conflicts. No credential details displayed.');
  process.exitCode=1;
}
