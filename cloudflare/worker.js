import { Container, getContainer } from "@cloudflare/containers";

// Explicit allowlist: deployment credentials never become application secrets.
const runtimeKeys = [
  "SAAS_ENABLED", "BILLING_MODE", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "BILLING_RETURN_URL",
  "STRIPE_PORTAL_CONFIGURATION_ID", "BILLING_SUCCESS_URL", "BILLING_CANCEL_URL",
  "BILLING_WEBHOOK_ENABLED",
  "DATABASE_URL", "PGSSL", "JWT_SECRET", "AUTH_TOKEN_TTL", "TOS_VERSION",
  "RESEND_API_KEY", "EMAIL_FROM", "APP_URL", "FRONTEND_URL",
  "R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY",
  "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AI_API_TOKEN", "CLOUDFLARE_MUSIC_MODEL",
  "MINIMAX_MUSIC_PROVIDER", "MINIMAX_MUSIC_TIMEOUT_MS",
  "NODE_ENV", "LOCAL_MODE", "PORT", "LOCAL_STORAGE_DIR", "MAX_UPLOAD_MB",
  "AI_PROVIDER", "OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_IMAGE_MODEL",
  "PEXELS_API_KEY", "MUSICSEO_YOUTUBE_API_KEY", "MUSICSEO_SPOTIFY_CLIENT_ID",
  "MUSICSEO_SPOTIFY_CLIENT_SECRET", "MUSICSEO_SPOTIFY_MARKET",
  "META_APP_ID", "META_APP_SECRET", "META_TOKEN_ENCRYPTION_KEY",
  "META_BUSINESS_LOGIN_CONFIG_ID", "META_GRAPH_VERSION", "PROMOTION_WEB_BASE_URL",
  "PROMOTION_API_PUBLIC_BASE_URL", "META_OAUTH_REDIRECT_URI",
  "STEM_AUDIO_PROVIDER_URL", "STEM_AUDIO_PROVIDER_API_KEY", "STEM_AUDIO_PROVIDER_NAME",
];

export class YSongApi extends Container {
  defaultPort = 8080;
  sleepAfter = "30m";

  constructor(ctx, env) {
    super(ctx, env);
    this.envVars = Object.fromEntries(runtimeKeys
      .filter((key) => typeof env[key] === "string" && env[key])
      .map((key) => [key, env[key]]));
  }

  onError() {
    // Container errors can include connection details. Keep public/log output generic.
    throw new Error("YSong API container could not start.");
  }
}

export default {
  async fetch(request, env) {
    const headers = new Headers(request.headers);
    headers.set("X-Forwarded-Proto", new URL(request.url).protocol === "https:" ? "https" : "http");
    try {
      // One instance preserves the API's existing in-process native render queue.
      return await getContainer(env.YSONG_API, "production").fetch(new Request(request, { headers }));
    } catch {
      return Response.json({ error: "api_unavailable" }, { status: 503 });
    }
  },
};
