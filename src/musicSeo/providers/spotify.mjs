import { average, buildLogScore, clampScore, daysSince, readJson, roundCompact } from "../utils.mjs";

export function spotifyConfigured() {
  return Boolean((process.env.MUSICSEO_SPOTIFY_CLIENT_ID || process.env.SPOTIFY_CLIENT_ID)?.trim() && (process.env.MUSICSEO_SPOTIFY_CLIENT_SECRET || process.env.SPOTIFY_CLIENT_SECRET)?.trim());
}

let cachedSpotifyToken = null;

async function getSpotifyAccessToken() {
  if (cachedSpotifyToken && cachedSpotifyToken.expiresAt > Date.now() + 60_000) {
    return cachedSpotifyToken.accessToken;
  }

  const clientId = (process.env.MUSICSEO_SPOTIFY_CLIENT_ID || process.env.SPOTIFY_CLIENT_ID)?.trim();
  const clientSecret = (process.env.MUSICSEO_SPOTIFY_CLIENT_SECRET || process.env.SPOTIFY_CLIENT_SECRET)?.trim();

  if (!clientId || !clientSecret) {
    throw new Error("Spotify credentials are not configured.");
  }

  const authHeader = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${authHeader}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });

  if (!response.ok) {
    throw new Error(`Spotify token request returned HTTP ${response.status}.`);
  }

  const payload = await readJson(response);
  if (!payload.access_token) {
    throw new Error("Spotify token response did not include an access token.");
  }

  const expiresInSeconds = Number(payload.expires_in || 3600);
  cachedSpotifyToken = {
    accessToken: payload.access_token,
    expiresAt: Date.now() + Math.max(60, expiresInSeconds) * 1000,
  };

  return cachedSpotifyToken.accessToken;
}

export async function searchSpotify(query) {
  if (!spotifyConfigured()) {
    return {
      platform: "Spotify",
      status: {
        platform: "Spotify",
        state: "not-configured",
        label: "Client credentials not configured",
        detail: "The YSong server does not currently have managed Spotify credentials configured.",
      },
      highlights: [],
    };
  }

  try {
    const accessToken = await getSpotifyAccessToken();
    const market = (process.env.MUSICSEO_SPOTIFY_MARKET || process.env.SPOTIFY_MARKET)?.trim() || "US";
    const searchParams = new URLSearchParams({
      q: query,
      type: "track,artist,album",
      limit: "10",
      market,
    });
    const response = await fetch(`https://api.spotify.com/v1/search?${searchParams.toString()}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Spotify search returned HTTP ${response.status}.`);
    }

    const payload = await readJson(response);
    const tracks = payload.tracks?.items || [];
    const artists = payload.artists?.items || [];
    const albums = payload.albums?.items || [];
    const totalResults = (payload.tracks?.total || tracks.length) + (payload.artists?.total || artists.length) + (payload.albums?.total || albums.length);
    const ageDays = tracks
      .map((track) => daysSince(track.album?.release_date))
      .filter((value) => typeof value === "number");
    const recentRatio = ageDays.length === 0 ? 0 : ageDays.filter((age) => age <= 730).length / ageDays.length;
    const uniqueArtists = new Set(
      [
        ...tracks.flatMap((track) => track.artists || []).map((artist) => artist.name),
        ...artists.map((artist) => artist.name),
      ].filter(Boolean),
    ).size;
    const avgAgeDays = average(ageDays);
    const demandSignal = buildLogScore(totalResults, 18);
    const momentumSignal = clampScore(recentRatio * 76 + (avgAgeDays <= 730 && avgAgeDays > 0 ? 14 : 0));
    const competitionSignal = buildLogScore(totalResults, 17);

    return {
      platform: "Spotify",
      status: {
        platform: "Spotify",
        state: "live",
        label: "Live catalog lane",
        detail: `${roundCompact(totalResults)} Spotify track matches reported in ${market}; top search items were sampled.`,
        resultCount: totalResults,
      },
      demandSignal,
      momentumSignal,
      competitionSignal,
      resultCount: totalResults,
      avgAgeDays,
      recentRatio,
      uniqueCreators: uniqueArtists,
      keywordEvidence: [
        ...tracks.flatMap((track) => [
          { platform: "Spotify", source: "title", text: track.name || "", weight: 1.4 },
          { platform: "Spotify", source: "album", text: track.album?.name || "", weight: 1.1 },
          ...((track.artists || []).map((artist) => ({ platform: "Spotify", source: "description", text: artist.name || "", weight: 0.8 }))),
        ]),
        ...artists.flatMap((artist) => [
          { platform: "Spotify", source: "description", text: artist.name || "", weight: 1.0 },
          ...((artist.genres || []).map((genre) => ({ platform: "Spotify", source: "genre", text: genre || "", weight: 1.9 }))),
        ]),
        ...albums.flatMap((album) => [
          { platform: "Spotify", source: "album", text: album.name || "", weight: 1.0 },
          ...((album.artists || []).map((artist) => ({ platform: "Spotify", source: "description", text: artist.name || "", weight: 0.7 }))),
        ]),
      ].filter((item) => item.text),
      highlights: tracks.slice(0, 4).map((track) => {
        const artists = (track.artists || []).map((artist) => artist.name).filter(Boolean).join(", ");
        const year = track.album?.release_date ? track.album.release_date.slice(0, 4) : undefined;
        return {
          platform: "Spotify",
          title: track.name || "Untitled track",
          subtitle: artists || track.album?.name || "Spotify result",
          metricLabel: "Release",
          metricValue: year || "Unknown",
          url: track.external_urls?.spotify,
        };
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Spotify provider error.";
    return {
      platform: "Spotify",
      status: {
        platform: "Spotify",
        state: "error",
        label: "Provider error",
        detail: `${message} Spotify Development Mode restrictions may also apply to personal apps.`,
      },
      highlights: [],
    };
  }
}
