import { buildLiveIntel } from "./analyze.mjs";
import {
  buildGenreRadar,
  getGenreAtlasScanJob,
  getGenreAtlasStats,
  getLatestGenreAtlasScanJob,
  searchGenreCatalog,
  startGenreAtlasScan,
} from "./genres.mjs";
import { spotifyConfigured } from "./providers/spotify.mjs";
import { youtubeConfigured } from "./providers/youtube.mjs";
import { normalizeQuery } from "./utils.mjs";
import {
  addOutcome,
  addScanSnapshot,
  getLocalPrediction,
  getModelStatus,
  listOutcomes,
  listScanSnapshots,
  outcomesToCsv,
  scansToCsv,
} from "./mlStore.mjs";

const ANALYZE_CACHE_TTL_MS = Math.max(60_000, Number(process.env.MUSICSEO_ANALYZE_CACHE_MS || 10 * 60_000));
const analyzeCache = new Map();
const rateWindows = new Map();

function getProviderHealth() {
  return [
    {
      platform: "iTunes",
      configured: true,
      label: "Ready without credentials",
      detail: "Apple Search API is available through the YSong backend without a private key.",
    },
    {
      platform: "YouTube",
      configured: youtubeConfigured(),
      label: youtubeConfigured() ? "YSong managed provider active" : "Managed provider unavailable",
      detail: youtubeConfigured()
        ? "Live YouTube search and video-stat sampling are enabled through server-side credentials."
        : "YSong has no managed YouTube credential configured on this server yet.",
    },
    {
      platform: "Spotify",
      configured: spotifyConfigured(),
      label: spotifyConfigured() ? "YSong managed provider active" : "Managed provider unavailable",
      detail: spotifyConfigured()
        ? "Spotify catalog search is enabled through YSong server-side credentials."
        : "YSong has no managed Spotify credential configured on this server yet.",
    },
  ];
}

function allowRequest(userId, bucket, limit, windowMs) {
  const key = `${String(userId)}:${bucket}`;
  const now = Date.now();
  const current = rateWindows.get(key);
  if (!current || now - current.startedAt >= windowMs) {
    rateWindows.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}

function rateLimit(req, res, bucket, limit, windowMs) {
  const userId = req.user?.id || "anonymous";
  if (allowRequest(userId, bucket, limit, windowMs)) return true;
  res.status(429).json({ error: "seo_rate_limited", detail: "Please wait before running more provider-heavy SEO scans." });
  return false;
}

function pruneAnalyzeCache() {
  const now = Date.now();
  for (const [key, entry] of analyzeCache) {
    if (now - entry.createdAt > ANALYZE_CACHE_TTL_MS) analyzeCache.delete(key);
  }
  while (analyzeCache.size > 300) analyzeCache.delete(analyzeCache.keys().next().value);
}

async function cachedLiveIntel(query) {
  const key = query.toLowerCase();
  const existing = analyzeCache.get(key);
  if (existing && Date.now() - existing.createdAt <= ANALYZE_CACHE_TTL_MS) return existing.value;
  const value = await buildLiveIntel(query);
  analyzeCache.set(key, { createdAt: Date.now(), value });
  pruneAnalyzeCache();
  return value;
}

export function registerMusicSeoRoutes(app, { requireAuth }) {
  const auth = requireAuth;

  app.get("/api/tools/seo/health", auth, (_req, res) => {
    res.json({
      status: "ok",
      service: "YSong SEO Intelligence",
      port: Number(process.env.PORT || 8081),
      credentialMode: "managed-server",
      providers: getProviderHealth(),
    });
  });

  app.get("/api/tools/seo/analyze", auth, async (req, res) => {
    if (!rateLimit(req, res, "analyze", 60, 15 * 60_000)) return;
    const query = normalizeQuery(req.query.q || "");
    if (!query) return res.status(400).json({ error: "missing_query" });
    if (query.length > 160) return res.status(400).json({ error: "query_too_long" });
    try {
      res.json(await cachedLiveIntel(query));
    } catch (error) {
      res.status(500).json({ error: "seo_analysis_failed", detail: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/tools/seo/genre-radar", auth, async (req, res) => {
    if (!rateLimit(req, res, "genre-radar", 15, 15 * 60_000)) return;
    const universe = String(req.query.universe || "starter");
    const top = Number(req.query.top) === 10 ? 10 : 20;
    if (universe !== "starter" && universe !== "expanded") {
      return res.status(400).json({ error: "invalid_genre_radar_universe" });
    }
    try {
      res.json(await buildGenreRadar(universe, top));
    } catch (error) {
      res.status(500).json({ error: "genre_radar_failed", detail: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/tools/seo/genre-catalog", auth, (req, res) => {
    res.json(searchGenreCatalog(String(req.query.q || ""), Number(req.query.limit || 20)));
  });

  app.get("/api/tools/seo/genre-atlas/stats", auth, (_req, res) => {
    res.json(getGenreAtlasStats());
  });

  app.get("/api/tools/seo/genre-atlas/start", auth, (req, res) => {
    if (!rateLimit(req, res, "genre-atlas", 3, 60 * 60_000)) return;
    const top = Number(req.query.top) === 10 ? 10 : 20;
    const refine = Number(req.query.refine || 80);
    try {
      res.status(202).json(startGenreAtlasScan(top, refine));
    } catch (error) {
      res.status(500).json({ error: "genre_atlas_start_failed", detail: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/tools/seo/genre-atlas/status", auth, (req, res) => {
    const job = getGenreAtlasScanJob(String(req.query.id || ""));
    if (!job) return res.status(404).json({ error: "atlas_scan_not_found" });
    res.json(job);
  });

  app.get("/api/tools/seo/genre-atlas/latest", auth, (_req, res) => {
    const job = getLatestGenreAtlasScanJob();
    if (!job) return res.status(404).json({ error: "atlas_scan_not_found" });
    res.json(job);
  });

  app.get("/api/tools/seo/outcomes", auth, async (req, res) => {
    res.json({ outcomes: await listOutcomes(req.user.id) });
  });

  app.post("/api/tools/seo/outcomes", auth, async (req, res) => {
    res.status(201).json({ outcome: await addOutcome(req.user.id, req.body || {}) });
  });

  app.get("/api/tools/seo/outcomes/export.csv", auth, async (req, res) => {
    res.type("text/csv").set("Content-Disposition", "attachment; filename=ysong-seo-outcomes.csv").send(outcomesToCsv(await listOutcomes(req.user.id)));
  });

  app.get("/api/tools/seo/scans", auth, async (req, res) => {
    res.json({ scans: await listScanSnapshots(req.user.id) });
  });

  app.post("/api/tools/seo/scans", auth, async (req, res) => {
    res.status(201).json({ scan: await addScanSnapshot(req.user.id, req.body || {}) });
  });

  app.get("/api/tools/seo/scans/export.csv", auth, async (req, res) => {
    res.type("text/csv").set("Content-Disposition", "attachment; filename=ysong-seo-scans.csv").send(scansToCsv(await listScanSnapshots(req.user.id)));
  });

  app.get("/api/tools/seo/ml/status", auth, async (req, res) => {
    res.json(await getModelStatus(req.user.id));
  });

  app.get("/api/tools/seo/ml/predict", auth, async (req, res) => {
    res.json(await getLocalPrediction(req.user.id, req.query || {}));
  });
}
