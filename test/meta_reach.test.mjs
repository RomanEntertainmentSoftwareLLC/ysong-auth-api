import test from "node:test";
import assert from "node:assert/strict";
import { fetchMetaReachEstimate, mapMetaReachEstimate } from "../src/promotion/meta-reach.mjs";

process.env.DATABASE_URL ||= "postgres://test:test@localhost/test";
const { buildMetaTargetingPayload } = await import("../src/promotion/meta.mjs");

test("reach adapter sends the published targeting shape to the selected account", async () => {
  const targetingSpec = buildMetaTargetingPayload({
    countries: ["us", "ca"], ageMin: 25, ageMax: 44, gender: "female",
    interests: [{ id: "6001", name: "Jazz" }],
    placementTargets: ["facebook_feed", "instagram_reels"],
  });
  let request;
  const result = await fetchMetaReachEstimate({
    graphBase: "https://graph.facebook.com/v26.0", token: "secret", adAccountId: "act_123",
    targetingSpec, fetchJson: async (url, init) => { request = { url, init }; return { data: [{ users_lower_bound: 12000, users_upper_bound: 15000, estimate_ready: true }] }; },
  });
  const url = new URL(request.url);
  assert.equal(url.pathname, "/v26.0/act_123/reachestimate");
  assert.equal(url.searchParams.get("optimize_for"), "IMPRESSIONS");
  assert.deepEqual(JSON.parse(url.searchParams.get("targeting_spec")), {
    geo_locations: { countries: ["US", "CA"] }, age_min: 25, age_max: 44, genders: [2],
    interests: [{ id: "6001", name: "Jazz" }], publisher_platforms: ["facebook", "instagram"],
    facebook_positions: ["feed"], instagram_positions: ["reels"],
  });
  assert.equal(request.init.headers.Authorization, "Bearer secret");
  assert.equal(url.searchParams.has("access_token"), false);
  assert.deepEqual(result, { source: "meta_reachestimate", kind: "modeled_audience_estimate", ready: true,
    estimate: null, lower: 12000, upper: 15000, targetingStatus: null });
});

test("unready and sentinel responses never become fabricated audience numbers", () => {
  assert.deepEqual(mapMetaReachEstimate({ data: [{ users: -1, estimate_ready: false, targeting_status: "PENDING" }] }), {
    source: "meta_reachestimate", kind: "modeled_audience_estimate", ready: false,
    estimate: null, lower: null, upper: null, targetingStatus: "PENDING",
  });
  assert.equal(mapMetaReachEstimate({ data: [{ users: 12000 }] }).estimate, 12000);
  assert.throws(() => mapMetaReachEstimate({ data: [] }), /meta_reach_response_invalid/);
  assert.throws(() => mapMetaReachEstimate({ data: [{ estimate_ready: true }] }), /meta_reach_response_invalid/);
});
