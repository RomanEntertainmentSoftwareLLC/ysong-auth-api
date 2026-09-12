import { average, clampScore, daysSince, readJson } from "../utils.mjs";

export async function searchItunes(query) {
  const country = process.env.ITUNES_COUNTRY?.trim() || "US";
  const params = new URLSearchParams({
    term: query,
    media: "music",
    entity: "musicTrack",
    limit: "25",
    country,
  });

  try {
    const response = await fetch(`https://itunes.apple.com/search?${params.toString()}`, {
      headers: {
			Accept: "application/json",
			"User-Agent": "MusicSEO/1.0 local research tool",
		},
    });

    if (!response.ok) {
      throw new Error(`Apple Search API returned HTTP ${response.status}.`);
    }

    const payload = await readJson(response);
    const tracks = Array.isArray(payload.results) ? payload.results : [];
    const returnedCount = typeof payload.resultCount === "number" ? payload.resultCount : tracks.length;
    const ageDays = tracks
      .map((track) => daysSince(track.releaseDate))
      .filter((value) => typeof value === "number");
    const recentRatio = ageDays.length === 0 ? 0 : ageDays.filter((age) => age <= 730).length / ageDays.length;
    const uniqueArtists = new Set(tracks.map((track) => track.artistName).filter(Boolean)).size;
    const avgAgeDays = average(ageDays);
    const demandSignal = clampScore((returnedCount / 25) * 62 + Math.min(uniqueArtists, 15) * 2.2);
    const momentumSignal = clampScore(recentRatio * 78 + (avgAgeDays <= 730 && avgAgeDays > 0 ? 14 : 0));
    const competitionSignal = clampScore((returnedCount / 25) * 58 + Math.min(uniqueArtists, 20) * 1.8);

    return {
      platform: "iTunes",
      status: {
        platform: "iTunes",
        state: "live",
        label: "Live catalog lane",
        detail: `${returnedCount} Apple catalog matches returned for this probe in ${country}.`,
        resultCount: returnedCount,
      },
      demandSignal,
      momentumSignal,
      competitionSignal,
      resultCount: returnedCount,
      avgAgeDays,
      recentRatio,
      uniqueCreators: uniqueArtists,
      highlights: tracks.slice(0, 4).map((track) => {
        const year = track.releaseDate ? new Date(track.releaseDate).getUTCFullYear() : undefined;
        return {
          platform: "iTunes",
          title: track.trackName || "Untitled track",
          subtitle: [track.artistName, track.collectionName].filter(Boolean).join(" — ") || "Apple catalog result",
          metricLabel: "Release",
          metricValue: year ? String(year) : "Unknown",
          url: track.trackViewUrl,
        };
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown iTunes provider error.";
    return {
      platform: "iTunes",
      status: {
        platform: "iTunes",
        state: "error",
        label: "Provider error",
        detail: message,
      },
      highlights: [],
    };
  }
}
