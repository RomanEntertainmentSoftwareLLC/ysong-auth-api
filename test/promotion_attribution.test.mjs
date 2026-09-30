import assert from "node:assert/strict";
import test from "node:test";
import { eventMetadataWithAttribution, parseAttribution, verifiedAttribution } from "../src/promotion/attribution.mjs";

const campaignId = "11111111-1111-4111-8111-111111111111";
const adId = "22222222-2222-4222-8222-222222222222";
const creativeId = "33333333-3333-4333-8333-333333333333";

test("redirect and landing aliases produce bounded attribution without other query parameters", () => {
  assert.deepEqual(parseAttribution({ ac: adId, cr: creativeId, dv: "spotify_a", utm_source: "meta", utm_campaign: "Fall launch", access_token: "secret", utm_medium: "https://secret.example/token" }), {
    adCampaignId: adId, creativeId, destinationVariantId: "spotify_a", utmSource: "meta", utmCampaign: "Fall launch",
  });
  assert.deepEqual(parseAttribution({ ysong_ad_campaign: adId, ysong_creative: creativeId, utm_content: "reel_01" }), {
    adCampaignId: adId, creativeId, utmContent: "reel_01",
  });
  assert.deepEqual(parseAttribution({ ac: [adId], utm_source: "a".repeat(121), dv: "bad?query" }), {});
});

test("paid identifiers must belong to this Smart Link and each other", async () => {
  const calls = [];
  const query = async (_sql, params) => {
    calls.push(params);
    return { rows: params[0] === adId && params[1] === campaignId ? [{ ad_id: adId, creative_id: params[2] === creativeId ? creativeId : null }] : [] };
  };
  assert.deepEqual(await verifiedAttribution(query, campaignId, { ac: adId, cr: creativeId, utm_source: "meta" }), { adCampaignId: adId, creativeId, utmSource: "meta" });
  assert.deepEqual(await verifiedAttribution(query, campaignId, { ac: adId, cr: "44444444-4444-4444-8444-444444444444" }), { adCampaignId: adId });
  assert.deepEqual(await verifiedAttribution(query, "55555555-5555-4555-8555-555555555555", { ac: adId, cr: creativeId }), {});
  assert.deepEqual(await verifiedAttribution(query, campaignId, { cr: creativeId }), {});
  assert.equal(calls.length, 3);
});

test("public events retain custom metadata but discard unverified attribution aliases", () => {
  assert.deepEqual(eventMetadataWithAttribution({ customLabel: "release", ac: "secret", adCampaignId: "fake", utm_source: "https://secret.example" }, { utmSource: "meta" }), {
    customLabel: "release", utmSource: "meta",
  });
});
