import { average, buildLogScore, clampScore, daysSince, median, readJson, roundCompact } from "../utils.mjs";

export function youtubeConfigured() {
  return Boolean((process.env.MUSICSEO_YOUTUBE_API_KEY || process.env.YOUTUBE_API_KEY)?.trim());
}

export async function searchYouTube(query) {
  const apiKey = (process.env.MUSICSEO_YOUTUBE_API_KEY || process.env.YOUTUBE_API_KEY)?.trim();
  if (!apiKey) {
    return {
      platform: "YouTube",
      status: {
        platform: "YouTube",
        state: "not-configured",
        label: "API key not configured",
        detail: "The YSong server does not currently have a managed YouTube credential configured.",
      },
      highlights: [],
    };
  }

  try {
    const searchParams = new URLSearchParams({
      part: "snippet",
      q: `${query} music`,
      type: "video",
      maxResults: "10",
      key: apiKey,
    });
    const searchResponse = await fetch(`https://www.googleapis.com/youtube/v3/search?${searchParams.toString()}`, {
      headers: { Accept: "application/json" },
    });

    if (!searchResponse.ok) {
      throw new Error(`YouTube search returned HTTP ${searchResponse.status}.`);
    }

    const searchPayload = await readJson(searchResponse);
    const videoIds = (searchPayload.items || [])
      .map((item) => item.id?.videoId)
      .filter((value) => Boolean(value));
    const totalResults = searchPayload.pageInfo?.totalResults || videoIds.length;

    if (videoIds.length === 0) {
      return {
        platform: "YouTube",
        status: {
          platform: "YouTube",
          state: "live",
          label: "Live search returned no videos",
          detail: "YouTube answered successfully, but this probe returned no video IDs.",
          resultCount: totalResults,
        },
        demandSignal: 0,
        momentumSignal: 0,
        competitionSignal: 0,
        resultCount: totalResults,
        highlights: [],
      };
    }

    const videoParams = new URLSearchParams({
      part: "snippet,statistics",
      id: videoIds.join(","),
      key: apiKey,
    });
    const videoResponse = await fetch(`https://www.googleapis.com/youtube/v3/videos?${videoParams.toString()}`, {
      headers: { Accept: "application/json" },
    });

    if (!videoResponse.ok) {
      throw new Error(`YouTube video-stat lookup returned HTTP ${videoResponse.status}.`);
    }

    const videoPayload = await readJson(videoResponse);
    const videos = Array.isArray(videoPayload.items) ? videoPayload.items : [];
    const viewCounts = videos
      .map((video) => Number(video.statistics?.viewCount || 0))
      .filter((value) => Number.isFinite(value));
    const ageDays = videos
      .map((video) => daysSince(video.snippet?.publishedAt))
      .filter((value) => typeof value === "number" && value > 0);
    const velocities = videos
      .map((video) => {
        const views = Number(video.statistics?.viewCount || 0);
        const age = daysSince(video.snippet?.publishedAt);
        return age && age > 0 ? views / age : 0;
      })
      .filter((value) => Number.isFinite(value) && value > 0);
    const medianViews = median(viewCounts);
    const medianVelocity = median(velocities);
    const avgAgeDays = average(ageDays);
    const demandSignal = buildLogScore(totalResults, 17);
    const momentumSignal = clampScore(buildLogScore(medianVelocity, 18) * 0.72 + buildLogScore(medianViews, 12) * 0.28);
    const competitionSignal = buildLogScore(totalResults, 16);
    const uniqueCreators = new Set(videos.map((video) => video.snippet?.channelTitle).filter(Boolean)).size;

    return {
      platform: "YouTube",
      status: {
        platform: "YouTube",
        state: "live",
        label: "Live video/search lane",
        detail: `${roundCompact(totalResults)} matching YouTube results reported; top videos were sampled for view velocity.`,
        resultCount: totalResults,
      },
      demandSignal,
      momentumSignal,
      competitionSignal,
      resultCount: totalResults,
      avgAgeDays,
      medianViews,
      uniqueCreators,
      highlights: [...videos]
        .sort((left, right) => Number(right.statistics?.viewCount || 0) - Number(left.statistics?.viewCount || 0))
        .slice(0, 4)
        .map((video) => ({
          platform: "YouTube",
          title: video.snippet?.title || "Untitled video",
          subtitle: video.snippet?.channelTitle || "YouTube result",
          metricLabel: "Views",
          metricValue: roundCompact(Number(video.statistics?.viewCount || 0)),
          url: video.id ? `https://www.youtube.com/watch?v=${video.id}` : undefined,
        })),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown YouTube provider error.";
    return {
      platform: "YouTube",
      status: {
        platform: "YouTube",
        state: "error",
        label: "Provider error",
        detail: message,
      },
      highlights: [],
    };
  }
}
