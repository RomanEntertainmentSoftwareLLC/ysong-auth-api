import test from "node:test";
import assert from "node:assert/strict";
import { metaDeliveryState, metaReviewState } from "../src/promotion/meta-delivery.mjs";

process.env.DATABASE_URL ||= "postgres://test:test@localhost/test";
const { deriveLocalMetaStatus } = await import("../src/promotion/meta.mjs");

const remote = (campaign, adSet = "ACTIVE", ad = "ACTIVE", issues_info = []) => ({
  campaign: { effective_status: campaign },
  adSets: [{ effective_status: adSet }],
  ads: [{ effective_status: ad, issues_info }],
});

test("submission and review never imply delivery", () => {
  for (const [input, expected] of [
    [remote("ACTIVE", "ACTIVE", "PENDING_REVIEW"), "in_review"],
    [remote("ACTIVE", "ACTIVE", "PREAPPROVED"), "in_review"],
    [remote("ACTIVE", "ACTIVE", "IN_PROCESS"), "submitted"],
    [remote("ACTIVE", "ACTIVE", "PENDING_BILLING_INFO"), "submitted"],
    [{ campaign: { effective_status: "ACTIVE" }, adSets: [], ads: [] }, "submitted"],
    [remote("ACTIVE", "PAUSED", "ADSET_PAUSED"), "paused"],
    [remote("PAUSED"), "paused"],
    [remote("ACTIVE"), "active"],
  ]) {
    assert.equal(metaDeliveryState(input).state, expected);
    assert.equal(deriveLocalMetaStatus(input), expected);
  }
});

test("ad rejection, errors, and provider reasons take precedence", () => {
  const rejected = remote("ACTIVE", "ACTIVE", "DISAPPROVED", [{ error_message: "Audio rights review failed", error_code: 123 }]);
  assert.deepEqual(metaDeliveryState(rejected), {
    state: "rejected", providerStatus: "ACTIVE",
    reasons: [{ level: "ad", message: "Audio rights review failed", code: "123" }],
  });
  assert.equal(metaDeliveryState(remote("PAUSED", "PAUSED", "WITH_ISSUES")).state, "rejected");
  assert.equal(metaDeliveryState(remote("ACTIVE", "ACTIVE", "ERROR")).state, "failed");
  assert.equal(metaDeliveryState(remote("ARCHIVED", "PAUSED", "PAUSED")).state, "archived");
  assert.equal(metaReviewState(remote("PAUSED", "PAUSED", "PENDING_REVIEW")), "pending");
});
