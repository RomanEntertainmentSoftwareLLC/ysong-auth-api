export function publicPlan(plan,mode,enabled) {
  return {id:plan.id,name:plan.name,monthlyPriceCents:plan.monthly_price_cents,currency:plan.currency,interval:plan.billing_interval,
    quota:plan.monthly_generation_quota,storageQuotaBytes:plan.storage_quota_bytes,capabilities:{...plan.capabilities,artwork:false,assistant:!!(plan.capabilities?.assistant&&Number.isInteger(plan.usage_limits?.assistant))},upgradeOrder:plan.upgrade_order,
    available:!!(enabled&&plan.available&&Number.isInteger(plan.monthly_generation_quota)&&plan.monthly_generation_quota>0&&plan.capabilities?.generation===true&&(plan.id==='free'||(plan.billing_prices?.[`stripe:${mode}`]&&plan.billing_products?.[`stripe:${mode}`])))};
}
