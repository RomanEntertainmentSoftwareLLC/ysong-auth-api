const REVIEW = new Set(["PENDING_REVIEW", "PREAPPROVED"]);
const REJECTED = new Set(["DISAPPROVED", "WITH_ISSUES"]);
const FAILED = new Set(["ERROR"]);
const STOPPED = new Set(["ARCHIVED", "DELETED"]);

function state(object) {
  return String(object?.effective_status || object?.status || "").toUpperCase();
}

function reasonsFor(object, level) {
  const issues = Array.isArray(object?.issues_info) ? object.issues_info : [];
  return issues.map(issue => ({
    level,
    message: String(issue?.error_message || issue?.message || issue?.title || "Meta reported an ad issue").slice(0, 1000),
    code: issue?.error_code == null ? null : String(issue.error_code),
  }));
}

export function metaDeliveryState(remote) {
  const campaign = state(remote?.campaign);
  const adSets = Array.isArray(remote?.adSets) ? remote.adSets : [];
  const ads = Array.isArray(remote?.ads) ? remote.ads : [];
  const states = [remote?.campaign, ...adSets, ...ads].flatMap(item =>
    [String(item?.status || "").toUpperCase(), state(item)]);
  const reasons = [
    ...reasonsFor(remote?.campaign, "campaign"),
    ...adSets.flatMap(item => reasonsFor(item, "ad_set")),
    ...ads.flatMap(item => reasonsFor(item, "ad")),
  ];
  let delivery = "submitted";
  if (states.some(value => REJECTED.has(value))) delivery = "rejected";
  else if (states.some(value => FAILED.has(value))) delivery = "failed";
  else if (STOPPED.has(campaign)) delivery = "archived";
  else if (campaign === "PAUSED" || campaign === "CAMPAIGN_PAUSED" ||
    (ads.length && ads.every(item => ["PAUSED", "ADSET_PAUSED", "CAMPAIGN_PAUSED"].includes(state(item))))) delivery = "paused";
  else if (states.some(value => REVIEW.has(value))) delivery = "in_review";
  else if (campaign === "ACTIVE" && adSets.some(item => state(item) === "ACTIVE") &&
    ads.some(item => state(item) === "ACTIVE")) delivery = "active";
  return { state: delivery, providerStatus: campaign, reasons };
}

export function metaReviewState(remote) {
  const objects = [remote?.campaign, ...(remote?.adSets || []), ...(remote?.ads || [])];
  const states = objects.flatMap(item => [String(item?.status || "").toUpperCase(), state(item)]);
  if (states.some(value => REJECTED.has(value))) return "rejected";
  if (states.some(value => REVIEW.has(value))) return "pending";
  return metaDeliveryState(remote).state === "active" ? "approved" : "unknown";
}
