import crypto from "crypto";

function encryptionKey() {
  const raw = String(process.env.META_TOKEN_ENCRYPTION_KEY || process.env.PROMOTION_TOKEN_ENCRYPTION_KEY || "").trim();
  if (!raw) throw new Error("promotion_token_encryption_key_missing");
  return crypto.createHash("sha256").update(raw).digest();
}

export function promotionSecretsConfigured() {
  return Boolean(String(process.env.META_TOKEN_ENCRYPTION_KEY || process.env.PROMOTION_TOKEN_ENCRYPTION_KEY || "").trim());
}

export function encryptSecret(value) {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptSecret(payload) {
  if (!payload) return "";
  const [version, ivB64, tagB64, dataB64] = String(payload).split(".");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) throw new Error("invalid_encrypted_secret");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
}
