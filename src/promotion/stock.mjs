import fs from "fs";
import path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";

const PEXELS_API = "https://api.pexels.com/v1/videos";
const MAX_IMPORT_BYTES = Math.max(25 * 1024 * 1024, Number(process.env.PROMOTION_STOCK_MAX_BYTES || 250 * 1024 * 1024));
const MAX_DURATION_SECONDS = 60;
const searchCache = new Map();
const SEARCH_CACHE_MS = 10 * 60 * 1000;

export function stockProviderStatus() {
  return {
    pexels: {
      configured: !!String(process.env.PEXELS_API_KEY || "").trim(),
      label: "Pexels",
      attributionUrl: "https://www.pexels.com/",
      free: true,
    },
    // Adapter slots intentionally exist now so Creative Studio is not coupled
    // to one vendor. Pixabay / Storyblocks / Shutterstock can be added here.
  };
}

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

function normalizeVideo(video) {
  const files = Array.isArray(video?.video_files) ? video.video_files : [];
  const previewFile = files.filter((f) => String(f?.file_type || "").toLowerCase() === "video/mp4" && /^https:\/\//i.test(String(f?.link || "")))
    .sort((a,b)=>Math.abs(Number(a?.height||0)-720)-Math.abs(Number(b?.height||0)-720))[0];
  return {
    provider: "pexels",
    id: String(video?.id || ""),
    width: Number(video?.width || 0),
    height: Number(video?.height || 0),
    durationSeconds: Number(video?.duration || 0),
    pageUrl: String(video?.url || ""),
    previewImage: String(video?.image || ""),
    previewVideoUrl: String(previewFile?.link || ""),
    contributor: {
      id: String(video?.user?.id || ""),
      name: String(video?.user?.name || "Pexels contributor"),
      url: String(video?.user?.url || ""),
    },
    files: files.map((file) => ({
      id: String(file?.id || ""),
      quality: String(file?.quality || ""),
      fileType: String(file?.file_type || ""),
      width: Number(file?.width || 0),
      height: Number(file?.height || 0),
      fps: Number(file?.fps || 0),
    })),
  };
}

export async function searchStockVideos({ provider = "pexels", query, orientation = "portrait", page = 1, perPage = 30, locale = "en-US" }) {
  if (provider !== "pexels") throw new Error("stock_provider_not_supported");
  const q = String(query || "").trim().slice(0, 160);
  if (q.length < 2) return { provider, page: 1, perPage, totalResults: 0, videos: [] };
  const params = new URLSearchParams({
    query: q,
    orientation: ["portrait", "landscape", "square"].includes(orientation) ? orientation : "portrait",
    size: "medium",
    locale: String(locale || "en-US").slice(0, 12),
    page: String(Math.max(1, Math.floor(Number(page) || 1))),
    per_page: String(Math.max(1, Math.min(80, Math.floor(Number(perPage) || 30)))),
  });
  const cacheKey = `${provider}|${params.toString()}`;
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const data = await pexelsJson(`${PEXELS_API}/search?${params.toString()}`);
  const videos = (Array.isArray(data?.videos) ? data.videos : [])
    .filter((v) => Number(v?.duration || 0) > 0 && Number(v?.duration || 0) <= MAX_DURATION_SECONDS)
    .map(normalizeVideo);
  const value = {
    provider,
    page: Number(data?.page || page || 1),
    perPage: Number(data?.per_page || perPage || 30),
    totalResults: Number(data?.total_results || 0),
    nextPage: data?.next_page ? Number(data?.page || page || 1) + 1 : null,
    videos,
    attribution: { label: "Videos provided by Pexels", url: "https://www.pexels.com/" },
  };
  searchCache.set(cacheKey,{expiresAt:Date.now()+SEARCH_CACHE_MS,value});
  if(searchCache.size>300){for(const [key,row] of searchCache){if(row.expiresAt<=Date.now())searchCache.delete(key);if(searchCache.size<=250)break;}}
  return value;
}

async function pexelsVideo(id) {
  const safeId = String(id || "").replace(/[^0-9]/g, "");
  if (!safeId) throw new Error("invalid_stock_video_id");
  return pexelsJson(`${PEXELS_API}/videos/${safeId}`);
}

function pickPexelsFile(video, preferredFileId = "") {
  const files = (Array.isArray(video?.video_files) ? video.video_files : [])
    .filter((f) => String(f?.file_type || "").toLowerCase() === "video/mp4" && /^https:\/\//i.test(String(f?.link || "")));
  if (!files.length) throw new Error("stock_video_mp4_unavailable");
  if (preferredFileId) {
    const exact = files.find((f) => String(f.id) === String(preferredFileId));
    if (exact) return exact;
  }
  // Prefer portrait HD near 1080x1920. Avoid pulling giant 4K originals for a
  // short ad background when FFmpeg will render to 1080x1920 anyway.
  const scored = files.map((f) => {
    const w = Number(f.width || 0), h = Number(f.height || 0);
    const portraitPenalty = h >= w ? 0 : 5_000_000;
    const oversizePenalty = h > 2160 || w > 2160 ? 2_000_000 : 0;
    const undersizePenalty = h < 720 ? 1_000_000 : 0;
    const targetDistance = Math.abs(w - 1080) * 1000 + Math.abs(h - 1920);
    const qualityBonus = String(f.quality || "") === "hd" ? -50_000 : 0;
    return { f, score: portraitPenalty + oversizePenalty + undersizePenalty + targetDistance + qualityBonus };
  }).sort((a, b) => a.score - b.score);
  return scored[0].f;
}

export async function resolveStockVideoForImport({ provider = "pexels", id, fileId = "" }) {
  if (provider !== "pexels") throw new Error("stock_provider_not_supported");
  const video = await pexelsVideo(id);
  const duration = Number(video?.duration || 0);
  if (!duration || duration > MAX_DURATION_SECONDS) {
    const error = new Error("stock_video_duration_not_supported");
    error.durationSeconds = duration;
    throw error;
  }
  const file = pickPexelsFile(video, fileId);
  return {
    video: normalizeVideo(video),
    downloadUrl: String(file.link),
    selectedFile: {
      id: String(file.id || ""), quality: String(file.quality || ""), fileType: String(file.file_type || "video/mp4"),
      width: Number(file.width || 0), height: Number(file.height || 0), fps: Number(file.fps || 0),
    },
  };
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
