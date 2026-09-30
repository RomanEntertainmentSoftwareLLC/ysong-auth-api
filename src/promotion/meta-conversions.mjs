import crypto from "crypto";

// Only a completed, separately consented fan signup may cross this boundary.
// Deliberately omit IP, user agent, cookies, referral URLs, and arbitrary metadata.
export function fanLeadEvent({ consent, email, eventId, eventSourceUrl, eventTime = Date.now() }) {
  if (consent !== true) throw new Error("meta_tracking_consent_required");
  if (!/^[0-9a-f-]{36}$/i.test(String(eventId || ""))) throw new Error("meta_event_id_invalid");
  const url = new URL(eventSourceUrl);
  if (url.protocol !== "https:") throw new Error("meta_event_source_invalid");
  const normalized = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error("meta_email_invalid");
  return {
    event_name: "Lead",
    event_time: Math.floor(eventTime / 1000),
    event_id: eventId,
    action_source: "website",
    event_source_url: `${url.origin}${url.pathname}`,
    user_data: { em: [crypto.createHash("sha256").update(normalized).digest("hex")] },
  };
}

export async function postMetaEvent({ graphBase, pixelId, token, event, fetchImpl = fetch }) {
  if (!/^[0-9]+$/.test(String(pixelId || ""))) throw new Error("meta_pixel_invalid");
  const body = new URLSearchParams({ access_token: token, data: JSON.stringify([event]) });
  const response = await fetchImpl(`${graphBase}/${pixelId}/events`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
    signal: AbortSignal.timeout(5000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.error || result.events_received !== 1) throw new Error("meta_event_submission_failed");
  // Meta accepted an event for processing; this does not prove a conversion.
  return { status: "accepted" };
}
