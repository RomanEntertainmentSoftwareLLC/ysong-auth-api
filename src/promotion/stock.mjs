import fs from "fs";
import path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";

const PEXELS_API = "https://api.pexels.com/v1/videos";
const MAX_IMPORT_BYTES = Math.max(25 * 1024 * 1024, Number(process.env.PROMOTION_STOCK_MAX_BYTES || 250 * 1024 * 1024));
const MAX_DURATION_SECONDS = 60;
const searchCache = new Map();
const SEARCH_CACHE_MS = 10 * 60 * 1000;

function pexelsKey() {
  const key = String(process.env.PEXELS_API_KEY || "").trim();
  if (!key) throw new Error("pexels_not_configured");
  return key;
}

async function pexelsJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(url, { headers: { Authorization: pexelsKey() }, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const error = new Error(`pexels_http_${res.status}`);
      error.statusCode = res.status;
      error.detail = text.slice(0, 1000);
      throw error;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalizePexelsVideo(video) {
  const files = Array.isArray(video?.video_files) ? video.video_files : [];
  const previewFile = files.filter((f) => String(f?.file_type || "").toLowerCase() === "video/mp4" && /^https:\/\//i.test(String(f?.link || "")))
    .sort((a, b) => Math.abs(Number(a?.height || 0) - 720) - Math.abs(Number(b?.height || 0) - 720))[0];
  const id = String(video?.id || "");
  const pageUrl = String(video?.url || "");
  const contributor = {
    id: String(video?.user?.id || ""),
    name: String(video?.user?.name || "Pexels contributor"),
    url: String(video?.user?.url || ""),
  };
  return {
    provider: "pexels",
    id,
    width: Number(video?.width || 0),
    height: Number(video?.height || 0),
    durationSeconds: Number(video?.duration || 0),
    pageUrl,
    previewImage: String(video?.image || ""),
    previewVideoUrl: String(previewFile?.link || ""),
    contributor,
    files: files.map((file) => ({
      id: String(file?.id || ""), quality: String(file?.quality || ""), fileType: String(file?.file_type || ""),
      width: Number(file?.width || 0), height: Number(file?.height || 0), fps: Number(file?.fps || 0),
    })),
    provenance: {
      provider: "pexels", providerId: id, sourceUrl: pageUrl,
      attribution: { label: "Videos provided by Pexels", url: "https://www.pexels.com/" },
      contributor,
    },
  };
}

function pickPexelsFile(video, preferredFileId = "") {
  const files = (Array.isArray(video?.video_files) ? video.video_files : [])
    .filter((f) => String(f?.file_type || "").toLowerCase() === "video/mp4" && /^https:\/\//i.test(String(f?.link || "")));
  if (!files.length) throw new Error("stock_video_mp4_unavailable");
  if (preferredFileId) {
    const exact = files.find((f) => String(f.id) === String(preferredFileId));
    if (exact) return exact;
  }
  // Prefer portrait HD near 1080x1920 without pulling giant 4K originals.
  return files.map((f) => {
    const w = Number(f.width || 0), h = Number(f.height || 0);
    const portraitPenalty = h >= w ? 0 : 5_000_000;
    const oversizePenalty = h > 2160 || w > 2160 ? 2_000_000 : 0;
    const undersizePenalty = h < 720 ? 1_000_000 : 0;
    const targetDistance = Math.abs(w - 1080) * 1000 + Math.abs(h - 1920);
    const qualityBonus = String(f.quality || "") === "hd" ? -50_000 : 0;
    return { f, score: portraitPenalty + oversizePenalty + undersizePenalty + targetDistance + qualityBonus };
  }).sort((a, b) => a.score - b.score)[0].f;
}

// Provider contract: id, label, attribution, configured(), search(options), resolve({id,fileId}).
// Adapters own credentials and translate vendor payloads into the shared video/provenance shape.
export function createStockProviderRegistry(providers = []) {
  const registry = new Map();
  for (const provider of providers) {
    const id = String(provider?.id || "").trim().toLowerCase();
    if (!id || typeof provider.search !== "function" || typeof provider.resolve !== "function") {
      throw new TypeError("invalid_stock_provider_adapter");
    }
    if (registry.has(id)) throw new Error("duplicate_stock_provider");
    registry.set(id, { ...provider, id });
  }
  return {
    get(id = "pexels") {
      const provider = registry.get(String(id || "").trim().toLowerCase());
      if (!provider) throw new Error("stock_provider_not_supported");
      return provider;
    },
    status() {
      return Object.fromEntries([...registry.values()].map((provider) => [provider.id, {
        configured: !!provider.configured(), label: provider.label, attributionUrl: provider.attribution.url,
        free: !!provider.free,
      }]));
    },
  };
}

const pexelsAdapter = {
  id: "pexels",
  label: "Pexels",
  attribution: { label: "Videos provided by Pexels", url: "https://www.pexels.com/" },
  free: true,
  configured: () => !!String(process.env.PEXELS_API_KEY || "").trim(),
  async search({ query, orientation, page, perPage, locale }) {
    const params = new URLSearchParams({
      query, orientation, size: "medium", locale, page: String(page), per_page: String(perPage),
    });
    const data = await pexelsJson(`${PEXELS_API}/search?${params.toString()}`);
    const videos = (Array.isArray(data?.videos) ? data.videos : [])
      .filter((v) => Number(v?.duration || 0) > 0 && Number(v?.duration || 0) <= MAX_DURATION_SECONDS)
      .map(normalizePexelsVideo);
    return {
      page: Number(data?.page || page), perPage: Number(data?.per_page || perPage),
      totalResults: Number(data?.total_results || 0), nextPage: data?.next_page ? Number(data?.page || page) + 1 : null,
      videos,
    };
  },
  async resolve({ id, fileId }) {
    const safeId = String(id || "").replace(/[^0-9]/g, "");
    if (!safeId) throw new Error("invalid_stock_video_id");
    const video = await pexelsJson(`${PEXELS_API}/videos/${safeId}`);
    const duration = Number(video?.duration || 0);
    if (!duration || duration > MAX_DURATION_SECONDS) {
      const error = new Error("stock_video_duration_not_supported");
      error.durationSeconds = duration;
      throw error;
    }
    const file = pickPexelsFile(video, fileId);
    return {
      video: normalizePexelsVideo(video), downloadUrl: String(file.link),
      selectedFile: {
        id: String(file.id || ""), quality: String(file.quality || ""), fileType: String(file.file_type || "video/mp4"),
        width: Number(file.width || 0), height: Number(file.height || 0), fps: Number(file.fps || 0),
      },
    };
  },
};

export const stockProviders = createStockProviderRegistry([pexelsAdapter]);

export function stockProviderStatus() { return stockProviders.status(); }

export async function searchStockVideos({ provider = "pexels", query, orientation = "portrait", page = 1, perPage = 30, locale = "en-US" }) {
  const adapter = stockProviders.get(provider);
  const q = String(query || "").trim().slice(0, 160);
  const safePage = Math.max(1, Math.floor(Number(page) || 1));
  const safePerPage = Math.max(1, Math.min(80, Math.floor(Number(perPage) || 30)));
  if (q.length < 2) return { provider: adapter.id, page: 1, perPage: safePerPage, totalResults: 0, nextPage: null, videos: [], attribution: adapter.attribution };
  const options = {
    query: q, orientation: ["portrait", "landscape", "square"].includes(orientation) ? orientation : "portrait",
    page: safePage, perPage: safePerPage, locale: String(locale || "en-US").slice(0, 12),
  };
  const cacheKey = `${adapter.id}|${JSON.stringify(options)}`;
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const result = await adapter.search(options);
  const value = { provider: adapter.id, ...result, attribution: adapter.attribution };
  searchCache.set(cacheKey, { expiresAt: Date.now() + SEARCH_CACHE_MS, value });
  if (searchCache.size > 300) {
    for (const [key, row] of searchCache) {
      if (row.expiresAt <= Date.now()) searchCache.delete(key);
      if (searchCache.size <= 250) break;
    }
  }
  return value;
}

export async function resolveStockVideoForImport({ provider = "pexels", id, fileId = "" }) {
  return stockProviders.get(provider).resolve({ id, fileId });
}

export async function downloadStockFile(url, destination, { maxBytes = MAX_IMPORT_BYTES } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("stock_download_https_required");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  let bytes = 0;
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`stock_download_http_${res.status}`);
    const announced = Number(res.headers.get("content-length") || 0);
    if (announced && announced > maxBytes) throw new Error("stock_video_too_large");
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        bytes += chunk.length;
        if (bytes > maxBytes) return cb(new Error("stock_video_too_large"));
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(destination, { flags: "wx" }));
    return { bytes, contentType: String(res.headers.get("content-type") || "video/mp4") };
  } catch (error) {
    await fs.promises.unlink(destination).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
