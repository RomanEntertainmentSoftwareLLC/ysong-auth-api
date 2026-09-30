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

test("Ads wizard selections and audience snapshot survive storage without credentials", () => {
  const wizard = AdsDraftSchema.parse({
    smartLinkCampaignId: id,
    selectedReleaseId: id, verifiedAudioReferenceId: id, creativeId: id, destinationId: id,
    connectedAssets: { connectionId: id, businessId: "12", adAccountId: "34", pageId: "56", instagramUserId: "78", pixelId: "90" },
    estimatedAudience: { source: "meta_reachestimate", kind: "modeled_audience_estimate", ready: true,
      estimate: null, lower: 1000, upper: 5000, capturedAt: "2026-09-30T12:00:00.000Z" },
    audience: { countries: ["US"], interestRefs: [{ id: "123", name: "Music" }] },
  });
  const stored = draftToStorage(wizard);
  const row = { campaign_id: id, source_track_id: null, name: stored.name, goal: stored.goal,
    daily_budget_minor: stored.dailyBudgetMinor, currency: stored.currency, placements: stored.placements,
    targeting: stored.targeting, meta_connection_id: stored.metaConnectionId, meta_ad_account_id: stored.metaAdAccountId,
    metadata: { adsDraft: stored.adsDraft } };
  const recovered = storageToDraft(row);
  assert.equal(AdsDraftSchema.safeParse(recovered).success, true);
  assert.equal(recovered.selectedReleaseId, id);
  assert.equal(recovered.verifiedAudioReferenceId, id);
  assert.equal(recovered.creativeId, id);
  assert.equal(recovered.destinationId, id);
  assert.deepEqual(recovered.connectedAssets, wizard.connectedAssets);
  assert.deepEqual(recovered.estimatedAudience, wizard.estimatedAudience);
  assert.deepEqual(recovered.audience.interestRefs, wizard.audience.interestRefs);
  assert.equal(recovered.dailyBudget.minor, 500);
  assert.equal(storageToDraft({ ...row, targeting: { ...row.targeting, countries: ["CA"] } }).estimatedAudience, null);
  assert.equal(JSON.stringify(projectAdsCampaign({ ...row, id, owner_user_id: id, status: "draft" })).includes("access_token"), false);
});

test("Ads draft rejects secrets and malformed snapshots in nested wizard fields", () => {
  assert.equal(AdsDraftSchema.safeParse({ ...draft, connectedAssets: { connectionId: id, businessId: "", adAccountId: "34", pageId: "56", instagramUserId: "", pixelId: "", accessToken: "secret" } }).success, false);
  assert.equal(AdsDraftSchema.safeParse({ ...draft, estimatedAudience: { source: "meta_reachestimate", kind: "modeled_audience_estimate", ready: true, estimate: null, lower: 5000, upper: 1000, capturedAt: "2026-09-30T12:00:00.000Z" } }).success, false);
  assert.equal(AdsDraftSchema.safeParse({ smartLinkCampaignId: id }).success, true);
});
