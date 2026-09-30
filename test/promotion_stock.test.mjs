import test from "node:test";
import assert from "node:assert/strict";
import { createStockProviderRegistry, searchStockVideos, resolveStockVideoForImport, stockProviderStatus } from "../src/promotion/stock.mjs";

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

test("Pexels search maps portrait metadata, pagination, previews, and import file references", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.PEXELS_API_KEY;
  process.env.PEXELS_API_KEY = "test-only-key";
  const video = {
    id: 42, width: 1080, height: 1920, duration: 12,
    url: "https://www.pexels.com/video/example-42/", image: "https://images.pexels.com/42.jpg",
    user: { id: 5, name: "Creator", url: "https://www.pexels.com/@creator" },
    video_files: [
      { id: 7, quality: "hd", file_type: "video/mp4", width: 1080, height: 1920, link: "https://videos.pexels.com/42.mp4" },
      { id: 8, quality: "sd", file_type: "video/mp4", width: 540, height: 960, link: "https://videos.pexels.com/42-small.mp4" },
    ],
  };
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), authorization: options.headers.Authorization });
    return new Response(JSON.stringify(String(url).includes("/search?")
      ? { page: 2, per_page: 2, total_results: 6, next_page: "https://api.pexels.com/v1/videos/search?page=3", videos: [video] }
      : video), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await searchStockVideos({ query: "unique portrait skyline", orientation: "portrait", size: "small", page: 2, perPage: 2 });
    assert.equal(result.nextPage, 3);
    assert.equal(result.totalResults, 6);
    assert.deepEqual({ width: result.videos[0].width, height: result.videos[0].height, orientation: result.videos[0].orientation, aspectRatio: result.videos[0].aspectRatio, socialFriendly: result.videos[0].socialFriendly },
      { width: 1080, height: 1920, orientation: "portrait", aspectRatio: 0.5625, socialFriendly: true });
    assert.equal(result.videos[0].previewVideoUrl, "https://videos.pexels.com/42-small.mp4");
    assert.equal(result.videos[0].files[0].id, "7");
    assert.match(calls[0].url, /orientation=portrait&size=small&locale=en-US&page=2&per_page=2/);
    assert.equal(calls[0].authorization, "test-only-key");
    const resolved = await resolveStockVideoForImport({ id: "42", fileId: "7" });
    assert.equal(resolved.selectedFile.id, "7");
    assert.equal(resolved.downloadUrl, "https://videos.pexels.com/42.mp4");
    await assert.rejects(resolveStockVideoForImport({ id: "42", fileId: "missing" }), /stock_video_file_not_found/);
    await assert.rejects(resolveStockVideoForImport({ id: "42x" }), /invalid_stock_video_id/);
    assert.equal(calls.length, 3);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.PEXELS_API_KEY;
    else process.env.PEXELS_API_KEY = originalKey;
  }
});

test("Pexels rate limits are bounded and subsequent requests honor cooldown", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.PEXELS_API_KEY;
  process.env.PEXELS_API_KEY = "test-only-key";
  let calls = 0;
  global.fetch = async () => { calls++; return new Response("", { status: 429, headers: { "Retry-After": "99999" } }); };
  try {
    await assert.rejects(searchStockVideos({ query: "rate limit sample" }), (error) => error.message === "pexels_rate_limited" && error.statusCode === 429 && error.retryAfterSeconds === 3600);
    await assert.rejects(searchStockVideos({ query: "rate limit sample two" }), (error) => error.message === "pexels_rate_limited" && error.statusCode === 429);
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.PEXELS_API_KEY;
    else process.env.PEXELS_API_KEY = originalKey;
  }
});
