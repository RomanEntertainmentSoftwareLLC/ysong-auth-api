import { readFileSync } from "node:fs";
import { searchItunes } from "./providers/itunes.mjs";
import { searchSpotify, spotifyConfigured } from "./providers/spotify.mjs";
import { searchYouTube, youtubeConfigured } from "./providers/youtube.mjs";
import { average, clampScore, normalizeQuery } from "./utils.mjs";

const STARTER_GENRE_POOL = [
  { genre: "Pop", category: "Mainstream" },
  { genre: "Hip Hop", category: "Mainstream" },
  { genre: "Gangster Rap", category: "Rap" },
  { genre: "Trap", category: "Rap" },
  { genre: "Drill", category: "Rap" },
  { genre: "K-Pop", category: "Global Pop" },
  { genre: "Japanese Pop", category: "Global Pop" },
  { genre: "City Pop", category: "Global Pop" },
  { genre: "Classic Rock", category: "Rock" },
  { genre: "Hard Rock", category: "Rock" },
  { genre: "Indie Rock", category: "Rock" },
  { genre: "Alternative Rock", category: "Rock" },
  { genre: "Nu Metal", category: "Metal" },
  { genre: "Symphonic Metal", category: "Metal" },
  { genre: "Power Metal", category: "Metal" },
  { genre: "Metalcore", category: "Metal" },
  { genre: "Dubstep", category: "Electronic" },
  { genre: "Techno", category: "Electronic" },
  { genre: "Gothic Techno", category: "Electronic" },
  { genre: "Hardstyle", category: "Electronic" },
  { genre: "Synthwave", category: "Electronic" },
  { genre: "Phonk", category: "Electronic" },
  { genre: "Lo-Fi Hip Hop", category: "Functional" },
  { genre: "Coding Music", category: "Functional" },
  { genre: "Sleep Music", category: "Functional" },
  { genre: "Meditation Music", category: "Functional" },
  { genre: "Ambient Music", category: "Functional" },
  { genre: "Cinematic Trailer Music", category: "Cinematic" },
  { genre: "Violin Hip Hop", category: "Hybrid" },
  { genre: "Cybergoth", category: "Alternative" },
  { genre: "Darkwave", category: "Alternative" },
  { genre: "Gothic Rock", category: "Alternative" },
  { genre: "Reggae", category: "Global" },
  { genre: "Afrobeat", category: "Global" },
  { genre: "Reggaeton", category: "Latin" },
  { genre: "Latin Pop", category: "Latin" },
  { genre: "Bachata", category: "Latin" },
  { genre: "Salsa", category: "Latin" },
  { genre: "R&B", category: "Soul" },
  { genre: "Neo Soul", category: "Soul" },
];

const EXPANDED_ONLY_GENRE_POOL = [
  { genre: "Blues", category: "Roots" },
  { genre: "Jazz", category: "Roots" },
  { genre: "Smooth Jazz", category: "Roots" },
  { genre: "Classical Music", category: "Classical" },
  { genre: "Piano Instrumental", category: "Classical" },
  { genre: "Country", category: "Country" },
  { genre: "Outlaw Country", category: "Country" },
  { genre: "Bluegrass", category: "Country" },
  { genre: "Gospel", category: "Spiritual" },
  { genre: "Worship Music", category: "Spiritual" },
  { genre: "Funk", category: "Soul" },
  { genre: "Disco", category: "Dance" },
  { genre: "House Music", category: "Electronic" },
  { genre: "Deep House", category: "Electronic" },
  { genre: "Trance", category: "Electronic" },
  { genre: "Psytrance", category: "Electronic" },
  { genre: "Drum and Bass", category: "Electronic" },
  { genre: "Jungle", category: "Electronic" },
  { genre: "Jersey Club", category: "Electronic" },
  { genre: "Hyperpop", category: "Pop" },
  { genre: "Vaporwave", category: "Alternative" },
  { genre: "Future Bass", category: "Electronic" },
  { genre: "Dancehall", category: "Global" },
  { genre: "Cumbia", category: "Latin" },
  { genre: "Tango", category: "Latin" },
  { genre: "Bolero", category: "Latin" },
  { genre: "Flamenco", category: "Global" },
  { genre: "Folk", category: "Roots" },
  { genre: "Folk Metal", category: "Metal" },
  { genre: "Death Metal", category: "Metal" },
  { genre: "Deathcore", category: "Metal" },
  { genre: "Pop Punk", category: "Rock" },
  { genre: "Grunge", category: "Rock" },
  { genre: "Shoegaze", category: "Alternative" },
  { genre: "Post Rock", category: "Alternative" },
  { genre: "Dark Ambient", category: "Alternative" },
  { genre: "Witch House", category: "Alternative" },
  { genre: "Chillstep", category: "Electronic" },
  { genre: "Electro Swing", category: "Hybrid" },
  { genre: "Anime Openings", category: "Global Pop" },
];

const LOCAL_ATLAS_ADDITIONS = [
  { genre: "Bass Techno", category: "Electronic", source: "Local watchlist" },
  { genre: "Booty Rap", category: "Rap", source: "Local watchlist" },
  { genre: "Cybergoth", category: "Alternative", source: "Local watchlist" },
  { genre: "Psytrance", category: "Electronic", source: "Local watchlist" },
  { genre: "Kentucky Bluegrass", category: "Country", source: "Local watchlist" },
  { genre: "Violin Hip Hop", category: "Hybrid", source: "Local watchlist" },
  { genre: "Coding Music", category: "Functional", source: "Local watchlist" },
  { genre: "Gothic Techno", category: "Electronic", source: "Local watchlist" },
];

const DISPLAY_OVERRIDES = new Map([
  ["r&b", "R&B"],
  ["k-pop", "K-Pop"],
  ["j-pop", "J-Pop"],
  ["c-pop", "C-Pop"],
  ["hip hop", "Hip Hop"],
  ["lo-fi", "Lo-Fi"],
  ["edm", "EDM"],
  ["uk", "UK"],
  ["us", "US"],
]);

const CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const genreRadarCache = new Map();
const atlasJobStore = new Map();
let activeAtlasJobId = null;
let latestCompletedAtlasJobId = null;

function liveSnapshots(snapshots) {
  return snapshots.filter((snapshot) => snapshot.status.state === "live");
}

function averageSignal(snapshots, signal) {
  const values = snapshots
    .map((snapshot) => snapshot[signal])
    .filter((value) => typeof value === "number");

  return clampScore(average(values));
}

function normalizeKey(value) {
  return normalizeQuery(value).toLowerCase();
}

function prettifyWord(word) {
  const lower = word.toLowerCase();
  const override = DISPLAY_OVERRIDES.get(lower);
  if (override) {
    return override;
  }

  return lower
    .split(/([-/])/)
    .map((part) => {
      if (!part || part === "-" || part === "/") {
        return part;
      }

      const tokenOverride = DISPLAY_OVERRIDES.get(part);
      if (tokenOverride) {
        return tokenOverride;
      }

      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join("");
}

function displayGenreName(rawGenre) {
  const normalized = normalizeKey(rawGenre);
  const exactOverride = DISPLAY_OVERRIDES.get(normalized);
  if (exactOverride) {
    return exactOverride;
  }

  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .map(prettifyWord)
    .join(" ");
}

function categorizeGenre(rawGenre) {
  const value = normalizeKey(rawGenre);

  if (/metal|deathcore|grind|blackgaze|djent|slam/.test(value)) return "Metal";
  if (/rap|hip hop|trap|drill|grime|phonk|boom bap|jersey club/.test(value)) return "Rap";
  if (/techno|house|trance|psy|dubstep|electro|edm|dnb|drum and bass|jungle|breakbeat|hardstyle|gabber|rave|club/.test(value)) return "Electronic";
  if (/pop|k-pop|j-pop|c-pop|idol|hyperpop|city pop/.test(value)) return "Pop";
  if (/reggaeton|bachata|salsa|cumbia|tango|bolero|latin|urbano|mariachi|banda|corrid/.test(value)) return "Latin";
  if (/country|bluegrass|honky|americana|western|nashville/.test(value)) return "Country";
  if (/blues|jazz|soul|funk|r&b|motown|gospel/.test(value)) return "Soul / Roots";
  if (/classical|orchestra|symphony|quartet|chamber|piano|violin|opera|baroque/.test(value)) return "Classical";
  if (/ambient|sleep|meditation|lo-fi|lofi|coding|study|relax/.test(value)) return "Functional";
  if (/folk|traditional|celtic|flamenco|fado|world|afro|reggae|dancehall/.test(value)) return "Global / Folk";
  if (/rock|punk|shoegaze|grunge|wave|goth|industrial|emo|indie/.test(value)) return "Rock / Alternative";

  return "Spotify Atlas";
}

function loadSpotifyAtlasEntries() {
  const atlasText = readFileSync(new URL("./data/spotify-genres.txt", import.meta.url), "utf8");
  const rawGenres = atlasText
    .split(/\r?\n/)
    .map((line) => normalizeQuery(line))
    .filter(Boolean);
  const entries = [];
  const seen = new Set();

  for (const rawGenre of rawGenres) {
    const key = normalizeKey(rawGenre);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    entries.push({
      genre: displayGenreName(rawGenre),
      normalizedGenre: key,
      category: categorizeGenre(rawGenre),
      source: "Spotify / Every Noise atlas",
    });
  }

  for (const entry of LOCAL_ATLAS_ADDITIONS) {
    const key = normalizeKey(entry.genre);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    entries.push({
      genre: entry.genre,
      normalizedGenre: key,
      category: entry.category,
      source: entry.source,
    });
  }

  return entries;
}

const ATLAS_GENRE_POOL = loadSpotifyAtlasEntries();
const ATLAS_ENTRY_BY_KEY = new Map(ATLAS_GENRE_POOL.map((entry) => [entry.normalizedGenre, entry]));

const UNIVERSES = {
  starter: {
    label: "Starter 40",
    description: "A 40-genre local candidate pool spanning mainstream, niche, hybrid, and functional music lanes.",
    entries: STARTER_GENRE_POOL,
  },
  expanded: {
    label: "Expanded 80",
    description: "The starter pool plus 40 additional genre probes for a broader live leaderboard.",
    entries: [...STARTER_GENRE_POOL, ...EXPANDED_ONLY_GENRE_POOL],
  },
};

function buildGenreScores(snapshots) {
  const live = liveSnapshots(snapshots);
  if (live.length === 0) {
    return {
      demand: 0,
      momentum: 0,
      competition: 0,
      supply: 0,
      marketHeat: 0,
      opportunity: 0,
      opportunityGap: 0,
      providersLive: 0,
      providerSummary: "No provider lane returned live data.",
    };
  }

  const demand = averageSignal(live, "demandSignal");
  const momentum = averageSignal(live, "momentumSignal");
  const competition = averageSignal(live, "competitionSignal");
  const supply = competition;
  const marketHeat = clampScore(demand * 0.62 + momentum * 0.38);
  const opportunity = clampScore(demand * 0.35 + momentum * 0.35 + (100 - supply) * 0.3);
  const opportunityGap = clampScore(demand * 0.42 + momentum * 0.24 + (100 - supply) * 0.34);
  const providers = live.map((snapshot) => snapshot.platform).join(" + ");

  return {
    demand,
    momentum,
    competition,
    supply,
    marketHeat,
    opportunity,
    opportunityGap,
    providersLive: live.length,
    providerSummary: `${live.length} live lane${live.length === 1 ? "" : "s"}: ${providers}`,
  };
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runWorker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

async function mapWithProgress(items, concurrency, worker, onProgress) {
  const results = new Array(items.length);
  let cursor = 0;
  let completed = 0;

  async function runWorker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      results[index] = await worker(item, index);
      completed += 1;
      const currentGenre = typeof item?.genre === "string"
        ? item.genre
        : typeof item?.candidate?.genre === "string"
          ? item.candidate.genre
          : "";
      onProgress({ completed, total: items.length, currentGenre });
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

async function scoreGenreCandidate(candidate) {
  const snapshots = await Promise.all([searchItunes(candidate.genre), searchYouTube(candidate.genre), searchSpotify(candidate.genre)]);
  const scores = buildGenreScores(snapshots);

  return {
    genre: candidate.genre,
    category: candidate.category,
    marketHeat: scores.marketHeat,
    opportunity: scores.opportunity,
    demand: scores.demand,
    momentum: scores.momentum,
    competition: scores.competition,
    supply: scores.supply,
    opportunityGap: scores.opportunityGap,
    providersLive: scores.providersLive,
    providerSummary: scores.providerSummary,
  };
}

function scoreSnapshotBundle(candidate, snapshots) {
  const scores = buildGenreScores(snapshots);
  return {
    genre: candidate.genre,
    category: candidate.category,
    marketHeat: scores.marketHeat,
    opportunity: scores.opportunity,
    demand: scores.demand,
    momentum: scores.momentum,
    competition: scores.competition,
    supply: scores.supply,
    opportunityGap: scores.opportunityGap,
    providersLive: scores.providersLive,
    providerSummary: scores.providerSummary,
  };
}

function sortByMetric(entries, metric) {
  return [...entries].sort((left, right) => {
    if (right[metric] !== left[metric]) {
      return right[metric] - left[metric];
    }

    if (right.demand !== left.demand) {
      return right.demand - left.demand;
    }

    return left.genre.localeCompare(right.genre);
  });
}

function selectDailyTarget(entries) {
  const candidates = entries
    .filter((entry) => entry.providersLive > 0 && entry.demand >= 45 && entry.momentum >= 25)
    .map((entry) => ({
      ...entry,
      targetScore: clampScore(entry.opportunityGap * 0.72 + entry.marketHeat * 0.18 + (100 - entry.supply) * 0.1),
    }))
    .sort((left, right) => {
      if (right.targetScore !== left.targetScore) return right.targetScore - left.targetScore;
      return right.momentum - left.momentum;
    });

  return candidates[0] || null;
}

function selectAvoidToday(entries) {
  const candidates = entries
    .filter((entry) => entry.demand >= 70 && entry.supply >= 82)
    .map((entry) => ({
      ...entry,
      crowdingWarning: clampScore(entry.demand * 0.45 + entry.supply * 0.45 + entry.marketHeat * 0.1),
    }))
    .sort((left, right) => right.crowdingWarning - left.crowdingWarning);

  return candidates[0] || null;
}

function buildScanSummary({ marketHeatLeaders, opportunityLeaders, opportunityGapLeaders, dailyTarget, avoidToday }) {
  const summary = [];
  if (marketHeatLeaders[0]) {
    summary.push(`Best heat: ${marketHeatLeaders[0].genre} at ${marketHeatLeaders[0].marketHeat}/100.`);
  }
  if (opportunityLeaders[0]) {
    summary.push(`Best whitespace: ${opportunityLeaders[0].genre} at ${opportunityLeaders[0].opportunity}/100.`);
  }
  if (opportunityGapLeaders[0]) {
    summary.push(`Best demand/supply gap: ${opportunityGapLeaders[0].genre} at ${opportunityGapLeaders[0].opportunityGap}/100.`);
  }
  if (dailyTarget) {
    summary.push(`Daily target: ${dailyTarget.genre} because demand is ${dailyTarget.demand}, momentum is ${dailyTarget.momentum}, and visible supply is ${dailyTarget.supply}.`);
  }
  if (avoidToday) {
    summary.push(`Avoid today: ${avoidToday.genre} is hot but extremely crowded with supply at ${avoidToday.supply}.`);
  }
  return summary;
}

function cloneReport(report, cacheState) {
  return {
    ...report,
    cacheState,
    leaderboards: {
      marketHeat: {
        ...report.leaderboards.marketHeat,
        entries: report.leaderboards.marketHeat.entries.map((entry) => ({ ...entry })),
      },
      opportunity: {
        ...report.leaderboards.opportunity,
        entries: report.leaderboards.opportunity.entries.map((entry) => ({ ...entry })),
      },
      opportunityGap: report.leaderboards.opportunityGap
        ? {
            ...report.leaderboards.opportunityGap,
            entries: report.leaderboards.opportunityGap.entries.map((entry) => ({ ...entry })),
          }
        : undefined,
    },
    insights: report.insights
      ? {
          dailyTarget: report.insights.dailyTarget ? { ...report.insights.dailyTarget } : null,
          avoidToday: report.insights.avoidToday ? { ...report.insights.avoidToday } : null,
          lowHangingFruit: report.insights.lowHangingFruit.map((entry) => ({ ...entry })),
          scanSummary: [...report.insights.scanSummary],
        }
      : undefined,
    notes: [...report.notes],
    universe: { ...report.universe },
    scanPlan: report.scanPlan ? { ...report.scanPlan } : undefined,
  };
}

function buildReport({ universe, universeKey, entries, topCount, cacheState, providerSummary, notes, scanPlan }) {
  const marketHeatLeaders = sortByMetric(entries, "marketHeat").slice(0, topCount);
  const opportunityLeaders = sortByMetric(entries, "opportunity").slice(0, topCount);
  const opportunityGapLeaders = sortByMetric(entries, "opportunityGap").slice(0, topCount);
  const dailyTarget = selectDailyTarget(entries);
  const avoidToday = selectAvoidToday(entries);
  const lowHangingFruit = opportunityGapLeaders.slice(0, Math.min(8, topCount));
  const scanSummary = buildScanSummary({ marketHeatLeaders, opportunityLeaders, opportunityGapLeaders, dailyTarget, avoidToday });

  return {
    universe: {
      key: universeKey,
      label: universe.label,
      description: universe.description,
      candidateCount: universe.entries.length,
    },
    generatedAt: new Date().toISOString(),
    topCount,
    scannedCount: universe.entries.length,
    cacheState,
    providerSummary,
    leaderboards: {
      marketHeat: {
        metric: "marketHeat",
        label: `Top ${topCount} by Market Heat`,
        description: "Closest match to ‘what looks hottest in the current candidate pool’: demand plus momentum, before crowding is treated as a punishment.",
        entries: marketHeatLeaders,
      },
      opportunity: {
        metric: "opportunity",
        label: `Top ${topCount} by Whitespace Opportunity`,
        description: "A competition-aware counterview: still active, but with more weight given to lanes that are not completely suffocated by crowding.",
        entries: opportunityLeaders,
      },
      opportunityGap: {
        metric: "opportunityGap",
        label: `Top ${topCount} by Opportunity Gap`,
        description: "The closest money-target view: demand and momentum weighed against visible supply saturation.",
        entries: opportunityGapLeaders,
      },
    },
    insights: {
      dailyTarget,
      avoidToday,
      lowHangingFruit,
      scanSummary,
    },
    notes,
    scanPlan,
  };
}

export function getGenreAtlasStats() {
  return {
    totalGenres: ATLAS_GENRE_POOL.length,
    spotifyAtlasGenres: ATLAS_GENRE_POOL.filter((entry) => entry.source === "Spotify / Every Noise atlas").length,
    localWatchlistAdditions: ATLAS_GENRE_POOL.filter((entry) => entry.source === "Local watchlist").length,
  };
}

export function searchGenreCatalog(rawQuery = "", rawLimit = 20) {
  const query = normalizeKey(rawQuery);
  const parsedLimit = Number(rawLimit);
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 60)) : 20;
  const sortedMatches = [...ATLAS_GENRE_POOL]
    .filter((entry) => !query || entry.normalizedGenre.includes(query))
    .sort((left, right) => {
      const leftExact = left.normalizedGenre === query ? 1 : 0;
      const rightExact = right.normalizedGenre === query ? 1 : 0;
      if (rightExact !== leftExact) return rightExact - leftExact;

      const leftStarts = query && left.normalizedGenre.startsWith(query) ? 1 : 0;
      const rightStarts = query && right.normalizedGenre.startsWith(query) ? 1 : 0;
      if (rightStarts !== leftStarts) return rightStarts - leftStarts;

      if (left.source !== right.source) {
        return left.source === "Local watchlist" ? -1 : 1;
      }

      return left.genre.localeCompare(right.genre);
    });

  return {
    query: normalizeQuery(rawQuery),
    totalGenres: ATLAS_GENRE_POOL.length,
    matchCount: sortedMatches.length,
    entries: sortedMatches.slice(0, limit).map((entry) => ({
      genre: entry.genre,
      category: entry.category,
      source: entry.source,
    })),
  };
}

export async function buildGenreRadar(universeKey = "starter", topCount = 20) {
  const universe = UNIVERSES[universeKey] || UNIVERSES.starter;
  const normalizedTopCount = topCount === 10 ? 10 : 20;
  const cacheKey = `${universeKey}:${normalizedTopCount}`;
  const cached = genreRadarCache.get(cacheKey);
  const now = Date.now();

  if (cached && now - cached.createdAt < CACHE_TTL_MS) {
    return cloneReport(cached.report, "cache-hit");
  }

  const parsedConcurrency = Number(process.env.GENRE_RADAR_CONCURRENCY || 4);
  const concurrency = Number.isFinite(parsedConcurrency) ? Math.max(1, Math.min(parsedConcurrency, 8)) : 4;
  const entries = await mapWithConcurrency(universe.entries, concurrency, scoreGenreCandidate);
  const providerSummary =
    entries.some((entry) => entry.providersLive > 0)
      ? "Genre Radar ranks the candidate pool using live Apple/iTunes catalog signals and YouTube search/video sampling when the YSong managed YouTube provider is available."
      : "Genre Radar could not obtain live provider signals for this scan.";

  const report = buildReport({
    universe,
    universeKey,
    entries,
    topCount: normalizedTopCount,
    cacheState: "fresh",
    providerSummary,
    notes: [
      `Rankings compare ${entries.length} preselected genre candidates; they are not a full 6,000+ genre census.`,
      "Market Heat is intentionally closest to “what looks hottest”; Whitespace Opportunity penalizes crowding more heavily.",
      "Use Probe to send any ranked genre into Niche Intel for the deeper report.",
    ],
    scanPlan: {
      mode: "quick-live-pool",
      dictionaryCount: entries.length,
      refinedCount: entries.length,
      coarseProvider: "Apple + YouTube",
      refineProvider: "Already direct-scored",
    },
  });

  genreRadarCache.set(cacheKey, { createdAt: now, report });
  return cloneReport(report, "fresh");
}

function cloneAtlasJob(job) {
  return {
    ...job,
    progress: { ...job.progress },
    report: job.report ? cloneReport(job.report, job.report.cacheState) : undefined,
  };
}

function createAtlasJob(topCount, refineCount) {
  const now = new Date().toISOString();
  return {
    id: `atlas-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    state: "running",
    stage: "queued",
    stageLabel: "Queued full atlas sweep.",
    createdAt: now,
    updatedAt: now,
    topCount,
    refineCount,
    progress: {
      completed: 0,
      total: ATLAS_GENRE_POOL.length,
      percent: 0,
      currentGenre: "",
    },
  };
}

function updateAtlasJob(job, patch) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
}

function updateAtlasProgress(job, { completed, total, currentGenre }) {
  updateAtlasJob(job, {
    progress: {
      completed,
      total,
      percent: total > 0 ? Math.round((completed / total) * 100) : 0,
      currentGenre,
    },
  });
}

function selectAtlasFinalists(coarseRows, refineCount) {
  const heatCandidates = sortByMetric(coarseRows.map((row) => row.entry), "marketHeat").slice(0, Math.ceil(refineCount * 0.7));
  const opportunityCandidates = sortByMetric(coarseRows.map((row) => row.entry), "opportunity").slice(0, refineCount);
  const selected = [];
  const seen = new Set();

  for (const entry of [...heatCandidates, ...opportunityCandidates]) {
    const key = normalizeKey(entry.genre);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    const row = coarseRows.find((candidateRow) => normalizeKey(candidateRow.candidate.genre) === key);
    if (row) {
      selected.push(row);
    }

    if (selected.length >= refineCount) {
      break;
    }
  }

  return selected;
}

async function runAtlasJob(job) {
  const atlasUniverse = {
    label: `Full Atlas ${ATLAS_GENRE_POOL.length.toLocaleString("en-US")}`,
    description: "A dictionary-scale sweep across the Spotify / Every Noise genre atlas plus a small local watchlist of extra genre terms.",
    entries: ATLAS_GENRE_POOL,
  };

  try {
    const parsedAppleConcurrency = Number(process.env.GENRE_ATLAS_APPLE_CONCURRENCY || 10);
    const appleConcurrency = Number.isFinite(parsedAppleConcurrency) ? Math.max(1, Math.min(parsedAppleConcurrency, 16)) : 10;
    updateAtlasJob(job, {
      stage: "apple-coarse",
      stageLabel: `Apple coarse pass: screening ${ATLAS_GENRE_POOL.length.toLocaleString("en-US")} dictionary terms locally before YouTube refinement.`,
      progress: {
        completed: 0,
        total: ATLAS_GENRE_POOL.length,
        percent: 0,
        currentGenre: "",
      },
    });

    const coarseRows = await mapWithProgress(
      ATLAS_GENRE_POOL,
      appleConcurrency,
      async (candidate) => {
        const itunesSnapshot = await searchItunes(candidate.genre);
        return {
          candidate,
          itunesSnapshot,
          entry: scoreSnapshotBundle(candidate, [itunesSnapshot]),
        };
      },
      (progress) => updateAtlasProgress(job, progress),
    );

    const finalists = selectAtlasFinalists(coarseRows, job.refineCount);
    let refinedEntries = finalists.map((row) => row.entry);
    let refineProvider = "Skipped: YouTube and Spotify keys not configured";

    if ((youtubeConfigured() || spotifyConfigured()) && finalists.length > 0) {
      const parsedYouTubeConcurrency = Number(process.env.GENRE_ATLAS_YOUTUBE_CONCURRENCY || 2);
      const youtubeConcurrency = Number.isFinite(parsedYouTubeConcurrency) ? Math.max(1, Math.min(parsedYouTubeConcurrency, 4)) : 2;
      updateAtlasJob(job, {
        stage: "youtube-refine",
        stageLabel: `Provider refinement: deepening ${finalists.length} Apple finalists with YouTube and/or Spotify without torching the full atlas.`,
        progress: {
          completed: 0,
          total: finalists.length,
          percent: 0,
          currentGenre: "",
        },
      });

      refinedEntries = await mapWithProgress(
        finalists,
        youtubeConcurrency,
        async (row) => {
          const providerCalls = [];
          if (youtubeConfigured()) providerCalls.push(searchYouTube(row.candidate.genre));
          if (spotifyConfigured()) providerCalls.push(searchSpotify(row.candidate.genre));
          const refinementSnapshots = await Promise.all(providerCalls);
          return scoreSnapshotBundle(row.candidate, [row.itunesSnapshot, ...refinementSnapshots]);
        },
        (progress) => updateAtlasProgress(job, progress),
      );
      refineProvider = `${[youtubeConfigured() ? "YouTube" : null, spotifyConfigured() ? "Spotify" : null].filter(Boolean).join(" + ")} top-${finalists.length} refinement`;
    }

    updateAtlasJob(job, {
      stage: "finalizing",
      stageLabel: "Finalizing the atlas leaderboard.",
    });

    const report = buildReport({
      universe: atlasUniverse,
      universeKey: "atlas",
      entries: refinedEntries,
      topCount: job.topCount,
      cacheState: "fresh",
      providerSummary: youtubeConfigured() || spotifyConfigured()
        ? `Full Atlas screened ${ATLAS_GENRE_POOL.length.toLocaleString("en-US")} genre terms with Apple/iTunes, then refined ${finalists.length} finalists with ${[youtubeConfigured() ? "YouTube" : null, spotifyConfigured() ? "Spotify" : null].filter(Boolean).join(" + ")}.`
        : `Full Atlas screened ${ATLAS_GENRE_POOL.length.toLocaleString("en-US")} genre terms with Apple/iTunes. Provider refinement was skipped because no YouTube or Spotify key was detected.`,
      notes: [
        `Dictionary source: ${getGenreAtlasStats().spotifyAtlasGenres.toLocaleString("en-US")} Spotify / Every Noise-derived genres plus ${getGenreAtlasStats().localWatchlistAdditions} local watchlist additions.`,
        youtubeConfigured() || spotifyConfigured()
          ? `Cross-platform leaderboards are produced after Apple narrows the field and ${[youtubeConfigured() ? "YouTube" : null, spotifyConfigured() ? "Spotify" : null].filter(Boolean).join(" + ")} deepens the top ${finalists.length} finalists.`
          : "This atlas run is Apple-only until YouTube and/or Spotify credentials are available locally.",
        "This is the dictionary-scale path: it is slower than Starter 40 / Expanded 80, but it stops the app from pretending a tiny pool is the entire genre universe.",
      ],
      scanPlan: {
        mode: "atlas-two-stage",
        dictionaryCount: ATLAS_GENRE_POOL.length,
        refinedCount: finalists.length,
        coarseProvider: "Apple / iTunes full dictionary coarse pass",
        refineProvider,
      },
    });

    updateAtlasJob(job, {
      state: "completed",
      stage: "completed",
      stageLabel: "Full atlas sweep complete.",
      progress: {
        completed: finalists.length || ATLAS_GENRE_POOL.length,
        total: finalists.length || ATLAS_GENRE_POOL.length,
        percent: 100,
        currentGenre: "",
      },
      report,
    });
    latestCompletedAtlasJobId = job.id;
    activeAtlasJobId = null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown atlas sweep error.";
    updateAtlasJob(job, {
      state: "failed",
      stage: "failed",
      stageLabel: "Full atlas sweep failed.",
      error: message,
    });
    activeAtlasJobId = null;
  }
}

export function startGenreAtlasScan(rawTopCount = 20, rawRefineCount = 80) {
  const topCount = Number(rawTopCount) === 10 ? 10 : 20;
  const parsedRefine = Number(rawRefineCount);
  const refineCount = Number.isFinite(parsedRefine) ? Math.max(20, Math.min(parsedRefine, 80)) : 80;

  if (activeAtlasJobId) {
    const active = atlasJobStore.get(activeAtlasJobId);
    if (active?.state === "running") {
      return cloneAtlasJob(active);
    }
  }

  const job = createAtlasJob(topCount, refineCount);
  atlasJobStore.set(job.id, job);
  activeAtlasJobId = job.id;
  queueMicrotask(() => {
    void runAtlasJob(job);
  });
  return cloneAtlasJob(job);
}

export function getGenreAtlasScanJob(jobId) {
  const normalizedJobId = normalizeQuery(jobId);
  if (!normalizedJobId) {
    return null;
  }

  const job = atlasJobStore.get(normalizedJobId);
  return job ? cloneAtlasJob(job) : null;
}

export function getLatestGenreAtlasScanJob() {
  if (!latestCompletedAtlasJobId) {
    return null;
  }

  return getGenreAtlasScanJob(latestCompletedAtlasJobId);
}

export function getAtlasEntryByGenre(rawGenre) {
  const key = normalizeKey(rawGenre);
  return ATLAS_ENTRY_BY_KEY.get(key) || null;
}
