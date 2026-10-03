import Stripe from 'stripe';

export const testCatalog = Object.freeze([
  {id:'basic',name:'YSong Basic',amount:999},
  {id:'pro',name:'YSong Pro',amount:1999},
  {id:'premium',name:'YSong Premium',amount:2999},
]);

function requireTest(object) {
  if (object.livemode !== false) throw new Error('Stripe returned a resource outside test mode.');
}
function validPrice(price, plan, productId) {
  return price.active && price.product === productId && price.currency === 'usd' &&
    price.unit_amount === plan.amount && price.type === 'recurring' &&
    price.billing_scheme === 'per_unit' && price.recurring?.interval === 'month' &&
    price.recurring.interval_count === 1 && price.recurring.usage_type === 'licensed' &&
    !price.custom_unit_amount && !price.transform_quantity;
}

// No dotenv import: credentials must be explicitly supplied by the operator environment.
export async function bootstrapStripeTest({env=process.env,applyTestMode=false,
  createClient=key=>new Stripe(key,{timeout:20000,maxNetworkRetries:2})}={}) {
  const key=env.STRIPE_SECRET_KEY;
  if (env.BILLING_MODE && env.BILLING_MODE !== 'test') throw new Error('BILLING_MODE must be test.');
  if (key && !/^sk_test_\S+$/.test(key)) throw new Error('Only a Stripe test secret key is accepted.');
  if (!key && applyTestMode) throw new Error('Test credentials are required to apply.');
  const result={mode:'test',status:key?'checked':'offline',plans:[{id:'free',productId:null,priceId:null,action:'no-subscription'}]};
  if (!key) {
    result.plans.push(...testCatalog.map(p=>({id:p.id,name:p.name,unitAmount:p.amount,currency:'usd',interval:'month',productId:null,priceId:null,action:'credentials-required'})));
    return result;
  }
  const stripe=createClient(key),products=[],prices=[];
  // List rather than eventually consistent search; SDK iteration traverses every page.
  for await (const product of stripe.products.list({limit:100})) { requireTest(product); products.push(product); }
  for await (const price of stripe.prices.list({limit:100})) { requireTest(price); prices.push(price); }
  // Validate the complete snapshot before any mutation. Ambiguity requires operator review.
  const resolved=testCatalog.map(plan=>{
    const matches=products.filter(p=>p.metadata?.ysong_plan===plan.id);
    if(matches.length>1 || matches.some(p=>!p.active)) throw new Error('Duplicate or archived YSong products require review.');
    const product=matches[0];
    const candidates=prices.filter(p=>p.metadata?.ysong_plan===plan.id || (product && p.product===product.id));
    if(candidates.length>1 || candidates.some(p=>p.metadata?.ysong_plan!==plan.id || !validPrice(p,plan,product?.id)))
      throw new Error('Conflicting YSong prices require review.');
    return {plan,product,price:candidates[0]};
  });
  for (let {plan,product,price} of resolved) {
    const action=price?'reuse':product?'create-price':'create-product-and-price';
    if (applyTestMode) {
      const metadata={ysong_plan:plan.id};
      if (!product) product=await stripe.products.create({name:plan.name,metadata},
        {idempotencyKey:`ysong:test:product:${plan.id}:v1`});
      requireTest(product);
      if (!product.active || product.metadata?.ysong_plan!==plan.id) throw new Error('Created product failed validation.');
      if (!price) price=await stripe.prices.create({product:product.id,currency:'usd',unit_amount:plan.amount,
        recurring:{interval:'month',interval_count:1,usage_type:'licensed'},metadata},
        {idempotencyKey:`ysong:test:price:${plan.id}:${product.id}:usd:${plan.amount}:month:v1`});
      requireTest(price);
      if (!validPrice(price,plan,product.id) || price.metadata?.ysong_plan!==plan.id) throw new Error('Created price failed validation.');
    }
    result.plans.push({id:plan.id,productId:product?.id??null,priceId:price?.id??null,action});
  }
  result.status=applyTestMode?'applied':'checked';
  return result;
}
