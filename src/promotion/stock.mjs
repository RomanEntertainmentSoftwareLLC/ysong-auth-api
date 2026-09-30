import fs from "fs";
import path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";

const PEXELS_API = "https://api.pexels.com/v1/videos";
const MAX_IMPORT_BYTES = Math.max(25 * 1024 * 1024, Number(process.env.PROMOTION_STOCK_MAX_BYTES || 250 * 1024 * 1024));
const MAX_DURATION_SECONDS = 60;
const searchCache = new Map();
const SEARCH_CACHE_MS = 10 * 60 * 1000;
let rateLimitedUntil = 0;

function stockError(message, statusCode, retryAfterSeconds) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (retryAfterSeconds) error.retryAfterSeconds = retryAfterSeconds;
  return error;
}

function retryDelay(headers) {
  const retryAfter = headers.get("retry-after");
  const seconds = Number(retryAfter);
  const retryDate = retryAfter && !Number.isFinite(seconds) ? Date.parse(retryAfter) : NaN;
  const reset = Number(headers.get("x-ratelimit-reset"));
  const delay = Number.isFinite(seconds) && retryAfter !== null ? seconds
    : Number.isFinite(retryDate) ? (retryDate - Date.now()) / 1000
    : Number.isFinite(reset) && reset > 0 ? reset - Date.now() / 1000 : 60;
  return Math.max(1, Math.min(3600, Math.ceil(delay)));
}

function pexelsKey() {
  const key = String(process.env.PEXELS_API_KEY || "").trim();
  if (!key) throw new Error("pexels_not_configured");
  return key;
}

async function pexelsJson(url) {
  const key = pexelsKey();
  if (rateLimitedUntil > Date.now()) {
    throw stockError("pexels_rate_limited", 429, Math.ceil((rateLimitedUntil - Date.now()) / 1000));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(url, { headers: { Authorization: key }, signal: controller.signal });
    if (!res.ok) {
      if (res.status === 429) {
        const delay = retryDelay(res.headers);
        rateLimitedUntil = Date.now() + delay * 1000;
        throw stockError("pexels_rate_limited", 429, delay);
      }
      throw stockError(`pexels_http_${res.status}`, 502);
    }
    try { return await res.json(); }
    catch { throw stockError("pexels_invalid_response", 502); }
  } catch (error) {
    if (error?.statusCode) throw error;
    throw stockError(error?.name === "AbortError" ? "pexels_timeout" : "pexels_unavailable", error?.name === "AbortError" ? 504 : 502);
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
  const width = Number(video?.width || 0);
  const height = Number(video?.height || 0);
  const orientation = width && height ? (height > width ? "portrait" : width > height ? "landscape" : "square") : "unknown";
  return {
    provider: "pexels",
    id,
    width,
    height,
    orientation,
    aspectRatio: width && height ? Number((width / height).toFixed(4)) : null,
    socialFriendly: orientation === "portrait" && height >= 1280,
    durationSeconds: Number(video?.duration || 0),
    pageUrl,
    previewImage: String(video?.image || ""),
    previewVideoUrl: String(previewFile?.link || ""),
    contributor,
    files: files.filter((file) => String(file?.file_type || "").toLowerCase() === "video/mp4" && /^https:\/\//i.test(String(file?.link || ""))).map((file) => ({
      id: String(file?.id || ""), quality: String(file?.quality || ""), fileType: String(file?.file_type || ""),
      width: Number(file?.width || 0), height: Number(file?.height || 0), fps: Number(file?.fps || 0),
    })),
    // Keep asset-level provenance separate from provider-wide search guidance.
    // Pexels video responses do not currently include asset license/attribution fields.
    provenance: {
      provider: "pexels", providerAssetId: id, canonicalSourceReference: pageUrl,
      creator: video?.user && (video.user.id != null || video.user.name || video.user.url)
        ? { id: video.user.id == null ? null : String(video.user.id), name: video.user.name == null ? null : String(video.user.name), url: video.user.url == null ? null : String(video.user.url) }
        : null,
    },
  };
}

function pickPexelsFile(video, preferredFileId = "") {
  const files = (Array.isArray(video?.video_files) ? video.video_files : [])
    .filter((f) => String(f?.file_type || "").toLowerCase() === "video/mp4" && /^https:\/\//i.test(String(f?.link || "")));
  if (!files.length) throw new Error("stock_video_mp4_unavailable");
  if (preferredFileId) {
    const exact = files.find((f) => String(f.id) === String(preferredFileId));
    if (!exact) throw stockError("stock_video_file_not_found", 400);
    return exact;
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
  async search({ query, orientation, size, page, perPage, locale }) {
    const params = new URLSearchParams({
      query, orientation, size, locale, page: String(page), per_page: String(perPage),
    });
    const data = await pexelsJson(`${PEXELS_API}/search?${params.toString()}`);
    const videos = (Array.isArray(data?.videos) ? data.videos : [])
      .filter((v) => Number(v?.duration || 0) > 0 && Number(v?.duration || 0) <= MAX_DURATION_SECONDS)
      .map(normalizePexelsVideo)
      .sort((a, b) => orientation === "portrait" ? Number(b.socialFriendly) - Number(a.socialFriendly) : 0);
    return {
      page: Number(data?.page || page), perPage: Number(data?.per_page || perPage),
      totalResults: Number(data?.total_results || 0), nextPage: data?.next_page ? Number(data?.page || page) + 1 : null,
      videos,
    };
  },
  async resolve({ id, fileId }) {
    const safeId = String(id || "");
    if (!/^\d+$/.test(safeId)) throw stockError("invalid_stock_video_id", 400);
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

export async function searchStockVideos({ provider = "pexels", query, orientation = "portrait", size = "medium", page = 1, perPage = 30, locale = "en-US" }) {
  const adapter = stockProviders.get(provider);
  const q = String(query || "").trim().slice(0, 160);
  const safePage = Math.max(1, Math.min(10000, Math.floor(Number(page)) || 1));
  const safePerPage = Math.max(1, Math.min(80, Math.floor(Number(perPage)) || 30));
  if (q.length < 2) return { provider: adapter.id, page: 1, perPage: safePerPage, totalResults: 0, nextPage: null, videos: [], attribution: adapter.attribution };
  const options = {
    query: q, orientation: ["portrait", "landscape", "square"].includes(orientation) ? orientation : "portrait",
    size: ["small", "medium", "large"].includes(size) ? size : "medium",
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
