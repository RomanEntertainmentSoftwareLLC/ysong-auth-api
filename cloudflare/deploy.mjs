import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import dotenv from "../node_modules/dotenv/lib/main.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const source = { ...dotenv.parse(fs.readFileSync(path.join(directory, "../.env"))), ...process.env };
const required = ["DATABASE_URL", "JWT_SECRET", "RESEND_API_KEY", "EMAIL_FROM", "R2_ENDPOINT",
  "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AI_API_TOKEN"];
const optional = ["AUTH_TOKEN_TTL", "TOS_VERSION", "AI_PROVIDER", "OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_IMAGE_MODEL",
  "SAAS_ENABLED", "BILLING_MODE", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "BILLING_RETURN_URL",
  "STRIPE_PORTAL_CONFIGURATION_ID", "BILLING_SUCCESS_URL", "BILLING_CANCEL_URL", "BILLING_WEBHOOK_ENABLED",
  "CLOUDFLARE_MUSIC_MODEL", "MINIMAX_MUSIC_TIMEOUT_MS",
  "PEXELS_API_KEY", "MUSICSEO_YOUTUBE_API_KEY", "MUSICSEO_SPOTIFY_CLIENT_ID", "MUSICSEO_SPOTIFY_CLIENT_SECRET",
  "MUSICSEO_SPOTIFY_MARKET", "META_APP_ID", "META_APP_SECRET", "META_TOKEN_ENCRYPTION_KEY",
  "META_BUSINESS_LOGIN_CONFIG_ID", "META_GRAPH_VERSION", "PROMOTION_WEB_BASE_URL", "PROMOTION_API_PUBLIC_BASE_URL",
  "META_OAUTH_REDIRECT_URI", "STEM_AUDIO_PROVIDER_URL", "STEM_AUDIO_PROVIDER_API_KEY", "STEM_AUDIO_PROVIDER_NAME"];
const missing = required.filter((name) => !source[name]);
if (missing.length) throw new Error(`Missing server configuration: ${missing.join(", ")}`);

// Sending-only keys cannot list domains; do not mistake that restriction for an invalid key.
const response = await fetch("https://api.resend.com/domains", {
  headers: { Authorization: `Bearer ${source.RESEND_API_KEY}` }, signal: AbortSignal.timeout(10000),
});
const domains = await response.json();
const sendingOnly = response.status === 401 && domains.name === "restricted_api_key";
if (!response.ok && !sendingOnly) throw new Error(`Resend verification failed (HTTP ${response.status}); production deployment was not attempted.`);
const senderDomain = source.EMAIL_FROM.match(/@([^>\s]+)/)?.[1];
if (!sendingOnly && !domains.data?.some((domain) => domain.name === senderDomain && domain.status === "verified")) {
  throw new Error("The configured Resend sender domain is not verified; production deployment was not attempted.");
}
if (sendingOnly) console.log("Resend key has restricted sending permissions; sender verification and delivery require a separate email check.");

const secretValues = Object.fromEntries([...required, ...optional].filter((name) => source[name]).map((name) => [name, source[name]]));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ysong-cloudflare-secrets-"));
const secretFile = path.join(temporary, "secrets.json");
try {
  // Values are runtime bindings, never Docker build arguments or browser variables.
  fs.writeFileSync(secretFile, JSON.stringify(secretValues), { mode: 0o600 });
  const result = spawnSync(process.execPath, [path.join(directory, "node_modules/wrangler/bin/wrangler.js"),
    "deploy", "--config", path.join(directory, "wrangler.jsonc"), "--secrets-file", secretFile], {
    cwd: directory, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: source.CLOUDFLARE_ACCOUNT_ID },
    encoding: "utf8", maxBuffer: 20 * 1024 * 1024, windowsHide: true,
  });
  let output = `${result.stdout || ""}${result.stderr || ""}`;
  for (const value of Object.values(secretValues).sort((a, b) => b.length - a.length)) {
    if (value.length >= 8) output = output.split(value).join("[REDACTED]");
  }
  process.stdout.write(output);
  if (result.error) console.error("Cloudflare deployment command could not complete.");
  process.exitCode = result.status ?? 1;
} finally {
  fs.unlinkSync(secretFile);
  fs.rmdirSync(temporary);
}
