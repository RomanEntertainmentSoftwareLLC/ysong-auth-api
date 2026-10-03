export const PLAN_IDS=['free','basic','pro','premium'];

// Cost evidence and budgets are operator inputs. The report never configures plans.
export function quotaReport(input={}){
  const evidence=input.providerCostEvidence;
  const valid=Array.isArray(evidence)&&evidence.length>0&&evidence.every(e=>
    typeof e.provider==='string'&&e.provider.length>0&&typeof e.model==='string'&&e.model.length>0&&
    typeof e.source==='string'&&e.source.length>0&&Number.isFinite(e.costCentsPerGeneration)&&e.costCentsPerGeneration>0);
  const multiplier=input.safetyMultiplier;
  const budgets=input.monthlyCostBudgetCents;
  const budgetValid=budgets&&typeof budgets==='object'&&PLAN_IDS.every(id=>Number.isInteger(budgets[id])&&budgets[id]>=0);
  if(!valid||!Number.isFinite(multiplier)||multiplier<1||!budgetValid)return {status:'insufficient_evidence',productionQuotas:Object.fromEntries(PLAN_IDS.map(id=>[id,null])),reason:'Explicit provider unit costs, source references, safety multiplier, and per-plan monthly cost budgets are required.'};
  const worstCost=Math.max(...evidence.map(e=>e.costCentsPerGeneration));
  return {status:'recommendations_only',productionQuotas:Object.fromEntries(PLAN_IDS.map(id=>[id,Math.floor(budgets[id]/(worstCost*multiplier))])),worstCostCentsPerGeneration:worstCost,safetyMultiplier:multiplier};
}
