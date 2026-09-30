import test from "node:test";
import assert from "node:assert/strict";
import { fetchMetaInterests, parseMetaInterestSearch } from "../src/promotion/meta-interests.mjs";

test("type-ahead input has a bounded query, result limit, and connection ID", () => {
  assert.deepEqual(parseMetaInterestSearch({ q: "  jazz  " }), { query: "jazz", limit: 20, connectionId: "" });
  assert.equal(parseMetaInterestSearch({ q: "jazz", limit: "50" }).limit, 50);
  for (const limit of ["NaN", "1.5", "0", "51", "Infinity"]) {
    assert.throws(() => parseMetaInterestSearch({ q: "jazz", limit }), /meta_interest_limit_invalid/);
  }
  assert.throws(() => parseMetaInterestSearch({ q: "j" }), /meta_interest_query_invalid/);
  assert.throws(() => parseMetaInterestSearch({ q: "x".repeat(121) }), /meta_interest_query_invalid/);
  assert.throws(() => parseMetaInterestSearch({ q: "jazz", connectionId: "other-user" }), /meta_interest_connection_invalid/);
});

test("live adapter uses Meta interest search and returns only real targeting records and supplied metadata", async () => {
  let requested;
  const interests = await fetchMetaInterests({
    graphBase: "https://graph.facebook.com/v26.0", token: "private-token", query: "jazz & blues", limit: 2,
    fetchJson: async (url, init) => {
      requested = { url, init };
      return { data: [
        { id: "6001", name: "Jazz music", audience_size_lower_bound: 1000, audience_size_upper_bound: 2000, path: ["Interests", "Music"], description: "Music genre" },
        { id: "6002", name: "Blues", audience_size_upper_bound: 5000 },
        { id: "6003", name: "Extra" },
      ] };
    },
  });
  const url = new URL(requested.url);
  assert.equal(url.pathname, "/v26.0/search");
  assert.equal(url.searchParams.get("type"), "adinterest");
  assert.equal(url.searchParams.get("q"), "jazz & blues");
  assert.equal(url.searchParams.get("limit"), "2");
  assert.equal(url.searchParams.has("access_token"), false);
  assert.equal(requested.init.headers.Authorization, "Bearer private-token");
  assert.deepEqual(interests, [
    { id: "6001", name: "Jazz music", audienceSizeLower: 1000, audienceSizeUpper: 2000, path: ["Interests", "Music"], description: "Music genre" },
    { id: "6002", name: "Blues", audienceSizeUpper: 5000 },
  ]);
  assert.equal(JSON.stringify(interests).includes("private-token"), false);
});

test("adapter rejects malformed Meta responses and skips incomplete records", async () => {
  const request = { graphBase: "https://graph.facebook.com/v26.0", token: "t", query: "rock", limit: 20 };
  await assert.rejects(fetchMetaInterests({ ...request, fetchJson: async () => ({}) }), /meta_interest_response_invalid/);
  const interests = await fetchMetaInterests({ ...request, fetchJson: async () => ({ data: [{ id: "1" }, { name: "Music" }, { id: "2", name: "Rock" }] }) });
  assert.deepEqual(interests, [{ id: "2", name: "Rock" }]);
});
