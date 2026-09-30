import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://test:test@localhost/test";
const { pool } = await import("../src/db.js");
const { analyticsFor, ysongPaidAttribution } = await import("../src/promotion/routes.mjs");

const destinationId = "11111111-1111-4111-8111-111111111111";
const creativeId = "22222222-2222-4222-8222-222222222222";
const adId = "33333333-3333-4333-8333-333333333333";

test("campaign attribution identifies destination and variant for shared creative", async () => {
  const original = pool.query;
  pool.query = async (sql) => {
    if (sql.includes("AS ad_campaign_id")) {
      assert.match(sql, /SELECT destination_id,/);
      assert.match(sql, /GROUP BY 1,2,3,4,5,6,7,8,9/);
      return { rows: [
        { destination_id: destinationId, ad_campaign_id: adId, creative_id: creativeId, destination_variant_id: "spotify_a", clicks: 3 },
        { destination_id: destinationId, ad_campaign_id: adId, creative_id: creativeId, destination_variant_id: "spotify_b", clicks: 2 },
      ] };
    }
    return { rows: [] };
  };
  try {
    const result = await analyticsFor(destinationId);
    assert.deepEqual(result.attribution.map(({ destinationId, creativeId, destinationVariantId, clicks }) => ({ destinationId, creativeId, destinationVariantId, clicks })), [
      { destinationId, creativeId, destinationVariantId: "spotify_a", clicks: 3 },
      { destinationId, creativeId, destinationVariantId: "spotify_b", clicks: 2 },
    ]);
  } finally { pool.query = original; }
});

test("paid analytics retains variant destination rows under one creative", async () => {
  const original = pool.query;
  pool.query = async (sql) => {
    if (sql.includes("JOIN promotion_destinations d")) {
      if (!sql.includes("destination_variant_id")) {
        assert.match(sql, /count\(DISTINCT NULLIF\(e\.visitor_id,''\)\)/);
        return { rows: [{ id: destinationId, label: "Spotify", platform: "spotify", clicks: 5, visitors: 3 }] };
      }
      assert.match(sql, /destination_variant_id/);
      assert.match(sql, /GROUP BY d\.id,d\.label,d\.platform,4,5/);
      return { rows: [
        { id: destinationId, label: "Spotify", platform: "spotify", creative_id: creativeId, destination_variant_id: "spotify_a", clicks: 3, visitors: 2 },
        { id: destinationId, label: "Spotify", platform: "spotify", creative_id: creativeId, destination_variant_id: "spotify_b", clicks: 2, visitors: 2 },
      ] };
    }
    if (sql.includes("AS creative_id,event_type")) return { rows: [{ creative_id: creativeId, event_type: "click", count: 5, visitors: 3 }] };
    if (sql.includes("FROM promotion_ad_creatives c")) return { rows: [{ id: creativeId, audio_snippet_id: adId, background_video_id: adId, meta_ad_ids: [] }] };
    if (sql.includes("SELECT destination_id,")) {
      assert.match(sql, /GROUP BY 1,2,3,4,5,6,7,8/);
      return { rows: [
        { destination_id: destinationId, creative_id: creativeId, destination_variant_id: "spotify_a", clicks: 3 },
        { destination_id: destinationId, creative_id: creativeId, destination_variant_id: "spotify_b", clicks: 2 },
      ] };
    }
    return { rows: [] };
  };
  try {
    const result = await ysongPaidAttribution({ id: adId, campaign_id: destinationId }, "2026-09-01", "2026-09-30");
    assert.equal(result.creatives.length, 1);
    assert.equal(result.creatives[0].ysong.clicks, 5);
    assert.deepEqual(result.creatives[0].ysong.destinations.map(({ id, creativeId, destinationVariantId, clicks }) => ({ id, creativeId, destinationVariantId, clicks })), [
      { id: destinationId, creativeId, destinationVariantId: "spotify_a", clicks: 3 },
      { id: destinationId, creativeId, destinationVariantId: "spotify_b", clicks: 2 },
    ]);
    assert.equal(result.destinations[0].clicks, 5);
    assert.equal(result.destinations[0].visitors, 3);
    assert.deepEqual(result.attribution.map(({ destinationId, destinationVariantId, clicks }) => ({ destinationId, destinationVariantId, clicks })), [
      { destinationId, destinationVariantId: "spotify_a", clicks: 3 },
      { destinationId, destinationVariantId: "spotify_b", clicks: 2 },
    ]);
  } finally { pool.query = original; }
});
