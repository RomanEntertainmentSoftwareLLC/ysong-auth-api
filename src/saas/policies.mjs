export const POLICY_IDS = ['terms','privacy','billing','generated-output','upload-rights','dmca-takedown','repeat-infringer','moderation','bridge-license'];
export const ACCEPTANCE_POLICY_IDS = ['terms','privacy','billing','generated-output','upload-rights','bridge-license'];
function approvedUrl(value){try{const url=new URL(value);return url.protocol==='https:'&&!!url.hostname&&!url.username&&!url.password;}catch{return false;}}
export function approvedPolicy(p){
 return !!(POLICY_IDS.includes(p?.policy_id) && p?.approved===true && p.active===true && typeof p.approval_reference==='string' && p.approval_reference.trim().length>=10 &&
  typeof p.version==='string' && p.version.trim().length>=3 && !/draft|placeholder|attorney.review.required/i.test(p.version) &&
  typeof p.url==='string' && approvedUrl(p.url) &&
  p.required===ACCEPTANCE_POLICY_IDS.includes(p.policy_id));
}
