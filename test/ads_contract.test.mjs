import test from "node:test";
import assert from "node:assert/strict";
import { AdsDraftSchema, draftToStorage, storageToDraft, projectAdsCampaign } from "../src/promotion/ads-contract.mjs";

const id = "11111111-1111-4111-8111-111111111111";
const draft = {
  smartLinkCampaignId: id, name: "Single launch", dailyBudget: { minor: 500, currency: "usd" },
  placements: [{ channel: "instagram", surface: "reels" }],
  audience: { countries: ["us"], ageMin: 21, ageMax: 35, interestRefs: [{ id: "interest-1", name: "Music" }] },
};

test("Ads draft translates to existing Promotion storage and back", () => {
  const stored = draftToStorage(AdsDraftSchema.parse(draft));
  assert.deepEqual(stored.placements, ["instagram"]);
  assert.deepEqual(stored.targeting.placementTargets, ["instagram_reels"]);
  assert.equal(stored.currency, "USD");
  const row = {
    id, owner_user_id: id, campaign_id: stored.campaignId, source_track_id: null,
    name: stored.name, goal: stored.goal, genre: stored.genre, genre_source: stored.genreSource,
    daily_budget_minor: stored.dailyBudgetMinor, currency: stored.currency,
    schedule_start: null, schedule_end: null, timezone: stored.timezone,
    placements: stored.placements, targeting: stored.targeting, ad_text: stored.adText,
    ad_headline: stored.adHeadline, language: stored.language, status: "draft",
    meta_campaign_id: "", meta_status: "", meta_last_error: {}, metadata: { metaDelivery: { remote: { access_token: "secret" } } },
  };
  assert.equal(AdsDraftSchema.safeParse(storageToDraft(row)).success, true);
  const view = projectAdsCampaign(row, { smartLink: { source_release_id: id },
    destinations: [{ id, platform: "spotify", label: "Spotify", url: "https://example.com", destination_kind: "stream", enabled: true, position: 0 }],
    creatives: [{ id, status: "ready", selected: true, audio_snippet_id: id }], snippets: [{ id }] });
  assert.equal(view.sourceReleaseId, id);
  assert.deepEqual(view.audioSnippetIds, [id]);
  assert.equal(view.creativeRefs[0].id, id);
  assert.equal(view.destinations[0].platform, "spotify");
  assert.equal(view.metaSubmission.state, "not_submitted");
  assert.equal(view.review.state, "not_requested");
  assert.equal(JSON.stringify(view).includes("meta_campaign_id"), false);
  assert.equal(JSON.stringify(view).includes("targeting"), false);
  assert.equal(JSON.stringify(view).includes("secret"), false);
});

test("Review and submission states do not claim approval for a paused remote draft", () => {
  const base = { id, owner_user_id: id, campaign_id: id, name: "Draft", goal: "song_growth",
    daily_budget_minor: 500, currency: "USD", placements: ["facebook"], targeting: {}, status: "paused",
    meta_campaign_id: "remote-id", meta_status: "PAUSED", meta_last_error: {} };
  const paused = projectAdsCampaign(base);
  assert.equal(paused.metaSubmission.state, "submitted");
  assert.equal(paused.review.state, "unknown");
  assert.equal(projectAdsCampaign({ ...base, status: "in_review" }).review.state, "pending");
  assert.equal(projectAdsCampaign({ ...base, status: "failed", meta_status: "DISAPPROVED" }).review.state, "rejected");
});

test("Ads draft rejects provider payloads, invalid ages, and duplicate placements", () => {
  assert.equal(AdsDraftSchema.safeParse({ ...draft, metaAdAccountId: "act_1" }).success, false);
  assert.equal(AdsDraftSchema.safeParse({ ...draft, audience: { ageMin: 40, ageMax: 20 } }).success, false);
  assert.equal(AdsDraftSchema.safeParse({ ...draft, placements: [draft.placements[0], draft.placements[0]] }).success, false);
});
