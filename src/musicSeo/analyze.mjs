import { searchItunes } from "./providers/itunes.mjs";
import { searchSpotify } from "./providers/spotify.mjs";
import { searchYouTube } from "./providers/youtube.mjs";
import { average, clampScore, normalizeQuery, roundCompact } from "./utils.mjs";

function getLiveSnapshots(snapshots) {
  return snapshots.filter((snapshot) => snapshot.status.state === "live");
}

function averageSignal(snapshots, signal) {
  const values = snapshots
    .map((snapshot) => snapshot[signal])
    .filter((value) => typeof value === "number");

  return clampScore(average(values));
}

function buildScores(liveSnapshots) {
  if (liveSnapshots.length === 0) {
    return { demand: 0, momentum: 0, competition: 0, opportunity: 0 };
  }

  const demand = averageSignal(liveSnapshots, "demandSignal");
  const momentum = averageSignal(liveSnapshots, "momentumSignal");
  const competition = averageSignal(liveSnapshots, "competitionSignal");
  const opportunity = clampScore(demand * 0.42 + momentum * 0.38 + (100 - competition) * 0.2);

  return { demand, momentum, competition, opportunity };
}

function buildVerdict(scores, liveCount) {
  if (liveCount === 0) {
    return {
      grade: "D",
      label: "No live providers answered",
      tone: "weak",
      summary: "The YSong SEO service is running, but no provider returned usable live data for this probe.",
    };
  }

  if (scores.opportunity >= 80) {
    return {
      grade: "A",
      label: "Strong live signal",
      tone: "strong",
      summary: "The available provider signals point to a niche with healthy demand, decent momentum, and competition that may still be worth attacking with sharp positioning.",
    };
  }

  if (scores.opportunity >= 66) {
    return {
      grade: "B",
      label: "Promising live lane",
      tone: "promising",
      summary: "The live provider blend looks viable. This is the kind of niche worth comparing against a few adjacent angles before deciding what to produce.",
    };
  }

  if (scores.opportunity >= 52) {
    return {
      grade: "C",
      label: "Test carefully",
      tone: "watch",
      summary: "There is some live evidence here, but not enough to call it a slam dunk. A tighter sub-niche or more provider coverage may improve the read.",
    };
  }

  return {
    grade: "D",
    label: "Weak or crowded signal",
    tone: "weak",
    summary: "The current provider mix does not suggest a high-priority lane. It may still be artistically interesting, but the market signal is not especially persuasive yet.",
  };
}

function buildSignalTrace(scores) {
  return [
    { label: "Demand", value: scores.demand },
    { label: "Momentum", value: scores.momentum },
    { label: "Whitespace", value: 100 - scores.competition },
    { label: "Opportunity", value: scores.opportunity },
  ];
}

function getCompetitionLabel(score) {
  if (score >= 72) {
    return "High";
  }

  if (score >= 48) {
    return "Medium";
  }

  return "Low";
}

function buildKeywordIdeas(query, scores) {
  const keywordBlueprints = [
    { suffix: "playlist", angle: "Core", momentumOffset: 0, competitionOffset: 10 },
    { suffix: "mix", angle: "Discovery", momentumOffset: 5, competitionOffset: 4 },
    { suffix: "instrumental", angle: "Long-tail", momentumOffset: -3, competitionOffset: -8 },
    { suffix: "cinematic", angle: "Adjacent", momentumOffset: 7, competitionOffset: -4 },
    { suffix: "for creators", angle: "Long-tail", momentumOffset: -5, competitionOffset: -12 },
    { suffix: "viral sounds", angle: "Discovery", momentumOffset: 9, competitionOffset: 14 },
  ];

  return keywordBlueprints.map((blueprint) => {
    const momentum = clampScore(scores.momentum * 0.64 + scores.demand * 0.26 + blueprint.momentumOffset);
    const competitionProxy = clampScore(scores.competition + blueprint.competitionOffset);

    return {
      term: `${query} ${blueprint.suffix}`,
      angle: blueprint.angle,
      momentum,
      competition: getCompetitionLabel(competitionProxy),
    };
  });
}

function buildPlatformSignals(snapshots) {
  return snapshots.map((snapshot) => {
    const compositeScore = clampScore(
      (snapshot.demandSignal || 0) * 0.42 +
        (snapshot.momentumSignal || 0) * 0.38 +
        (100 - (snapshot.competitionSignal || 100)) * 0.2,
    );

    if (snapshot.status.state !== "live") {
      return {
        platform: snapshot.platform,
        score: 0,
        status: snapshot.status.label,
        insight: snapshot.status.detail,
      };
    }

    return {
      platform: snapshot.platform,
      score: compositeScore,
      status: snapshot.status.label,
      insight: snapshot.status.detail,
    };
  });
}

function buildReasons(query, scores, snapshots) {
  const liveSnapshots = getLiveSnapshots(snapshots);
  const livePlatforms = liveSnapshots.map((snapshot) => snapshot.platform).join(", ");
  const statuses = snapshots.filter((snapshot) => snapshot.status.state !== "live");
  const reasons = [
    `“${query}” is currently scored from ${liveSnapshots.length} live provider lane${liveSnapshots.length === 1 ? "" : "s"}: ${livePlatforms || "none"}.`,
    `Demand lands at ${scores.demand}/100, momentum at ${scores.momentum}/100, and competition at ${scores.competition}/100 under the present provider blend.`,
    `Opportunity resolves to ${scores.opportunity}/100 after competition is treated as a penalty rather than a benefit.`,
  ];

  const appleSnapshot = liveSnapshots.find((snapshot) => snapshot.platform === "iTunes");
  if (appleSnapshot?.resultCount !== undefined) {
    reasons.push(`Apple catalog search returned ${appleSnapshot.resultCount} visible matches; that helps establish whether the phrase surfaces meaningful released-music results.`);
  }

  const youtubeSnapshot = liveSnapshots.find((snapshot) => snapshot.platform === "YouTube");
  if (youtubeSnapshot?.medianViews !== undefined) {
    reasons.push(`YouTube's sampled top-video median view count is about ${roundCompact(youtubeSnapshot.medianViews)}, which feeds the momentum side of the read.`);
  }

  const spotifySnapshot = liveSnapshots.find((snapshot) => snapshot.platform === "Spotify");
  if (spotifySnapshot?.resultCount !== undefined) {
    reasons.push(`Spotify reports roughly ${roundCompact(spotifySnapshot.resultCount)} matching track results in the configured market, adding catalog-pressure context.`);
  }

  if (statuses.length > 0) {
    reasons.push(`Coverage is still partial: ${statuses.map((snapshot) => `${snapshot.platform} — ${snapshot.status.label}`).join("; ")}.`);
  }

  return reasons;
}

export async function buildLiveIntel(queryInput) {
  const query = normalizeQuery(queryInput);
  const snapshots = await Promise.all([searchItunes(query), searchYouTube(query), searchSpotify(query)]);
  const liveSnapshots = getLiveSnapshots(snapshots);
  const scores = buildScores(liveSnapshots);
  const liveProviderCount = liveSnapshots.length;
  const sourceSummary =
    liveProviderCount === snapshots.length
      ? "All configured provider lanes returned live data."
      : `${liveProviderCount} of ${snapshots.length} provider lanes returned live data for this query.`;

  return {
    query,
    scores,
    verdict: buildVerdict(scores, liveProviderCount),
    trend: buildSignalTrace(scores),
    platformSignals: buildPlatformSignals(snapshots),
    keywordIdeas: buildKeywordIdeas(query, scores),
    reasons: buildReasons(query, scores, snapshots),
    highlights: snapshots.flatMap((snapshot) => snapshot.highlights),
    meta: {
      dataMode: liveProviderCount === snapshots.length ? "live-full" : "live-partial",
      generatedAt: new Date().toISOString(),
      providerStatuses: snapshots.map((snapshot) => snapshot.status),
      sourceSummary,
    },
  };
}
