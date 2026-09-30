import test from "node:test";
import assert from "node:assert/strict";
import { createStockProviderRegistry, searchStockVideos, stockProviderStatus } from "../src/promotion/stock.mjs";

test("stock provider registry exposes adapter status without credentials", () => {
  const registry = createStockProviderRegistry([{
    id: "sample", label: "Sample", attribution: { label: "Provided by Sample", url: "https://sample.example/" },
    free: false, configured: () => true, search: async () => ({}), resolve: async () => ({}),
  }]);
  assert.deepEqual(registry.status(), { sample: {
    configured: true, label: "Sample", attributionUrl: "https://sample.example/", free: false,
  } });
  assert.throws(() => registry.get("unknown"), /stock_provider_not_supported/);
});

test("search returns the shared pagination and attribution contract for empty queries", async () => {
  const result = await searchStockVideos({ provider: "pexels", query: " " });
  assert.deepEqual({ provider: result.provider, page: result.page, perPage: result.perPage, totalResults: result.totalResults, nextPage: result.nextPage }, {
    provider: "pexels", page: 1, perPage: 30, totalResults: 0, nextPage: null,
  });
  assert.deepEqual(result.attribution, { label: "Videos provided by Pexels", url: "https://www.pexels.com/" });
  assert.equal(stockProviderStatus().pexels.label, "Pexels");
  assert.equal(JSON.stringify(stockProviderStatus()).includes("PEXELS_API_KEY"), false);
});
