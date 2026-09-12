import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const DATA_ROOT = resolve(
  process.env.MUSICSEO_DATA_DIR ||
    join(process.env.LOCAL_STORAGE_DIR || join(process.cwd(), "..", "data", "uploads"), "musicseo"),
);

function safeUserId(userId) {
  return String(userId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 160) || "unknown";
}

function userPaths(userId) {
  const dir = join(DATA_ROOT, `user-${safeUserId(userId)}`);
  return {
    dir,
    outcomes: join(dir, "release-outcomes.json"),
    scans: join(dir, "scan-snapshots.json"),
    modelMeta: join(dir, "model-meta.json"),
  };
}

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(path, value, dir) {
  await ensureDir(dir);
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

export async function listOutcomes(userId) {
  const paths = userPaths(userId);
  return readJson(paths.outcomes, []);
}

export async function addOutcome(userId, payload) {
  const paths = userPaths(userId);
  const outcomes = await listOutcomes(userId);
  const now = new Date().toISOString();
  const record = {
    id: `outcome-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    createdAt: now,
    updatedAt: now,
    title: String(payload.title || "Untitled release").slice(0, 120),
    genre: String(payload.genre || "Unknown genre").slice(0, 90),
    platform: String(payload.platform || "YouTube").slice(0, 40),
    releaseDate: String(payload.releaseDate || now.slice(0, 10)).slice(0, 20),
    demand: clampNumber(payload.demand, 0, 100, 50),
    supply: clampNumber(payload.supply, 0, 100, 50),
    momentum: clampNumber(payload.momentum, 0, 100, 50),
    competition: clampNumber(payload.competition, 0, 100, 50),
    opportunityGap: clampNumber(payload.opportunityGap, 0, 100, 50),
    views24h: clampNumber(payload.views24h, 0, 999999999, 0),
    views7d: clampNumber(payload.views7d, 0, 999999999, 0),
    views30d: clampNumber(payload.views30d, 0, 999999999, 0),
    streams30d: clampNumber(payload.streams30d, 0, 999999999, 0),
    revenue30d: clampNumber(payload.revenue30d, 0, 999999999, 0),
    notes: String(payload.notes || "").slice(0, 2000),
  };
  outcomes.unshift(record);
  await writeJson(paths.outcomes, outcomes.slice(0, 5000), paths.dir);
  return record;
}

export async function listScanSnapshots(userId) {
  const paths = userPaths(userId);
  return readJson(paths.scans, []);
}

export async function addScanSnapshot(userId, payload) {
  const paths = userPaths(userId);
  const scans = await listScanSnapshots(userId);
  const record = {
    id: `scan-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    source: String(payload.source || "manual").slice(0, 60),
    genre: String(payload.genre || "Unknown genre").slice(0, 90),
    demand: clampNumber(payload.demand, 0, 100, 50),
    supply: clampNumber(payload.supply, 0, 100, 50),
    momentum: clampNumber(payload.momentum, 0, 100, 50),
    competition: clampNumber(payload.competition, 0, 100, 50),
    opportunityGap: clampNumber(payload.opportunityGap, 0, 100, 50),
    marketHeat: clampNumber(payload.marketHeat, 0, 100, 50),
    providersLive: clampNumber(payload.providersLive, 0, 3, 0),
  };
  scans.unshift(record);
  await writeJson(paths.scans, scans.slice(0, 10000), paths.dir);
  return record;
}

export async function getModelStatus(userId) {
  const paths = userPaths(userId);
  const outcomes = await listOutcomes(userId);
  const scans = await listScanSnapshots(userId);
  const meta = await readJson(paths.modelMeta, null);
  const usableOutcomes = outcomes.filter((row) => Number(row.views30d || row.views7d || row.views24h) > 0).length;
  const confidence = usableOutcomes >= 30 ? "medium" : usableOutcomes >= 8 ? "early" : "low";
  return {
    engine: "YSong SEO outcome-learning foundation",
    fastApiPort: 0,
    localData: {
      outcomes: outcomes.length,
      usableOutcomes,
      scanSnapshots: scans.length,
    },
    model: meta || {
      trained: false,
      trainedAt: null,
      algorithm: "Transparent heuristic until a validated model is trained",
      modelPath: "managed-by-ysong",
    },
    confidence,
    recommendation: usableOutcomes >= 8
      ? "Enough seed data exists to experiment with a first trained model, but validate it before trusting it."
      : "Log at least 8-30 releases before treating learned predictions as meaningful.",
  };
}

export async function getLocalPrediction(userId, input) {
  const outcomes = await listOutcomes(userId);
  const usableOutcomes = outcomes.filter((row) => Number(row.views30d || row.views7d || row.views24h) > 0).length;
  const demand = clampNumber(input.demand, 0, 100, 50);
  const supply = clampNumber(input.supply, 0, 100, 50);
  const momentum = clampNumber(input.momentum, 0, 100, 50);
  const competition = clampNumber(input.competition, 0, 100, 50);
  const opportunityGap = clampNumber(
    input.opportunityGap,
    0,
    100,
    Math.round(demand * 0.45 + momentum * 0.25 + (100 - supply) * 0.3),
  );
  const predictedPerformance = Math.round(
    Math.max(0, Math.min(100, demand * 0.28 + momentum * 0.24 + opportunityGap * 0.33 + (100 - supply) * 0.1 - competition * 0.05)),
  );
  const confidence = usableOutcomes >= 30 ? "medium" : usableOutcomes >= 8 ? "early" : "low";
  return {
    genre: String(input.genre || "Current target"),
    predictedPerformance,
    confidence,
    modelMode: usableOutcomes >= 8 ? "ml-ready-fallback" : "rules-until-training-data",
    trainingRows: usableOutcomes,
    drivers: [
      { feature: "Opportunity gap", impact: opportunityGap },
      { feature: "Demand", impact: demand },
      { feature: "Momentum", impact: momentum },
      { feature: "Supply penalty", impact: 100 - supply },
      { feature: "Competition penalty", impact: 100 - competition },
    ].sort((a, b) => b.impact - a.impact),
    note: usableOutcomes >= 8
      ? "YSong has enough outcome rows to begin model experiments; this score remains the transparent fallback for now."
      : "This remains a transparent fallback score until more real release outcomes are logged.",
  };
}

export function outcomesToCsv(outcomes) {
  const header = ["id", "title", "genre", "platform", "releaseDate", "demand", "supply", "momentum", "competition", "opportunityGap", "views24h", "views7d", "views30d", "streams30d", "revenue30d", "notes"];
  const rows = outcomes.map((row) => header.map((key) => escapeCsv(row[key] ?? "")).join(","));
  return [header.join(","), ...rows].join("\n");
}

export function scansToCsv(scans) {
  const header = ["id", "createdAt", "source", "genre", "demand", "supply", "momentum", "competition", "opportunityGap", "marketHeat", "providersLive"];
  const rows = scans.map((row) => header.map((key) => escapeCsv(row[key] ?? "")).join(","));
  return [header.join(","), ...rows].join("\n");
}

function clampNumber(value, min, max, fallback) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numericValue)));
}

function escapeCsv(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}
