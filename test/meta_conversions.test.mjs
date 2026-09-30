import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { fanLeadEvent, postMetaEvent } from "../src/promotion/meta-conversions.mjs";

const id = "11111111-1111-4111-8111-111111111111";

test("fan lead requires separate consent and sends only bounded fields", () => {
  const input = { consent: true, email: " FAN@Example.com ", eventId: id,
    eventSourceUrl: "https://ysong.example/p/song?email=private&fbclid=secret", eventTime: 1_700_000_000_000 };
  assert.throws(() => fanLeadEvent({ ...input, consent: false }), /meta_tracking_consent_required/);
  assert.deepEqual(fanLeadEvent(input), {
    event_name: "Lead", event_time: 1_700_000_000, event_id: id,
    action_source: "website", event_source_url: "https://ysong.example/p/song",
    user_data: { em: [crypto.createHash("sha256").update("fan@example.com").digest("hex")] },
  });
});

test("Meta transport reports acceptance only for an actual accepted response", async () => {
  const event = fanLeadEvent({ consent: true, email: "fan@example.com", eventId: id,
    eventSourceUrl: "https://ysong.example/p/song" });
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return { ok: true, json: async () => ({ events_received: 0 }) };
  };
  await assert.rejects(postMetaEvent({ graphBase: "https://graph.facebook.com/v26.0", pixelId: "123", token: "secret", event, fetchImpl }), /meta_event_submission_failed/);
  assert.equal(captured.url, "https://graph.facebook.com/v26.0/123/events");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.body.get("access_token"), "secret");
  assert.deepEqual(JSON.parse(captured.init.body.get("data")), [event]);
  assert.equal(captured.url.includes("secret"), false);
  await assert.rejects(postMetaEvent({ graphBase: "https://graph.facebook.com/v26.0", pixelId: "bad", token: "secret", event, fetchImpl }), /meta_pixel_invalid/);
});
