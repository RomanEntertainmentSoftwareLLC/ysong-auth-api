import assert from "node:assert/strict";
import test from "node:test";
import { DestinationSchema, saveDestinations } from "../src/promotion/destinations.mjs";
import { PROMOTION_PLATFORM_CATALOG } from "../src/promotion/catalog.mjs";

const campaignId = "11111111-1111-4111-8111-111111111111";
const firstId = "22222222-2222-4222-8222-222222222222";
const secondId = "33333333-3333-4333-8333-333333333333";
const destination = (platform, url, id) => DestinationSchema.parse({ id, platform, label: platform, url });

function clientWith(rows) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith("SELECT")) return { rows };
      return { rows: [] };
    },
  };
}

test("known choices and arbitrary services share the same destination schema", () => {
  const choices = new Set(PROMOTION_PLATFORM_CATALOG.map(({ id }) => id));
  for (const id of ["spotify", "apple_music", "amazon_music", "tidal", "flo", "youtube", "rumble", "bilibili", "bitchute", "soundcloud", "bandcamp", "vinyl", "store", "official_site", "custom"]) {
    assert.ok(choices.has(id), id);
    assert.equal(destination(id, `https://example.com/${id}`).platform, id);
  }
  assert.equal(destination("my_new_service", "https://example.com/custom").platform, "my_new_service");
  assert.equal(DestinationSchema.safeParse({ platform: "custom", label: "Unsafe", url: "javascript:alert(1)" }).success, false);
});

test("reordering and editing preserve destination IDs", async () => {
  const client = clientWith([
    { id: firstId, platform: "spotify", url: "https://example.com/first" },
    { id: secondId, platform: "bilibili", url: "https://example.com/second" },
  ]);
  await saveDestinations(client, campaignId, [
    destination("bilibili", "https://example.com/updated", secondId),
    destination("spotify", "https://example.com/first", firstId),
  ]);
  const writes = client.calls.slice(1);
  assert.equal(writes.length, 2);
  assert.ok(writes.every(({ sql }) => sql.startsWith("UPDATE")));
  assert.deepEqual(writes.map(({ params }) => [params[0], params[6]]), [[secondId, 0], [firstId, 1]]);
});

test("legacy payloads retain matching IDs and remove only omitted destinations", async () => {
  const client = clientWith([
    { id: firstId, platform: "spotify", url: "https://example.com/first" },
    { id: secondId, platform: "bilibili", url: "https://example.com/second" },
  ]);
  await saveDestinations(client, campaignId, [destination("spotify", "https://example.com/first")]);
  assert.equal(client.calls[1].params[0], firstId);
  assert.equal(client.calls[2].params[0], secondId);
  assert.ok(client.calls[2].sql.startsWith("DELETE"));
});

test("a new custom URL is inserted at its supplied display position", async () => {
  const client = clientWith([{ id: firstId, platform: "spotify", url: "https://example.com/first" }]);
  await saveDestinations(client, campaignId, [
    destination("official_site", "https://artist.example/music"),
    destination("spotify", "https://example.com/first", firstId),
  ]);
  assert.ok(client.calls[1].sql.startsWith("INSERT"));
  assert.match(client.calls[1].params[0], /^[0-9a-f-]{36}$/);
  assert.equal(client.calls[1].params[6], 0);
  assert.equal(client.calls[2].params[0], firstId);
  assert.equal(client.calls[2].params[6], 1);
});

test("a foreign or duplicate destination ID is rejected before writes", async () => {
  const client = clientWith([{ id: firstId, platform: "spotify", url: "https://example.com/first" }]);
  await assert.rejects(saveDestinations(client, campaignId, [destination("spotify", "https://example.com/first", secondId)]), /invalid_destination_id/);
  await assert.rejects(saveDestinations(client, campaignId, [destination("spotify", "https://example.com/first", firstId), destination("spotify", "https://example.com/first", firstId)]), /invalid_destination_id/);
  assert.equal(client.calls.filter(({ sql }) => !sql.startsWith("SELECT")).length, 0);
});
