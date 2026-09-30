import { z } from "zod";

const placement = z.object({
  channel: z.enum(["facebook", "instagram"]),
  surface: z.enum(["feed", "reels", "stories"]),
}).strict();

const connectedAssets = z.object({
  connectionId: z.string().uuid(),
  businessId: z.string().regex(/^[0-9]*$/),
  adAccountId: z.string().regex(/^[0-9]+$/),
  pageId: z.string().regex(/^[0-9]+$/),
  instagramUserId: z.string().regex(/^[0-9]*$/),
  pixelId: z.string().regex(/^[0-9]*$/),
}).strict();

const estimatedAudience = z.object({
  source: z.literal("meta_reachestimate"),
  kind: z.literal("modeled_audience_estimate"),
  ready: z.boolean(),
  estimate: z.number().finite().nonnegative().nullable(),
  lower: z.number().finite().nonnegative().nullable(),
  upper: z.number().finite().nonnegative().nullable(),
  targetingStatus: z.string().max(100).nullable().default(null),
  capturedAt: z.string().datetime(),
}).strict().superRefine((value, ctx) => {
  if (value.lower !== null && value.upper !== null && value.lower > value.upper)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["upper"], message: "Upper audience bound must be at least lower bound" });
  if (value.ready && value.estimate === null && value.lower === null && value.upper === null)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ready"], message: "Ready estimate needs a numeric value or bound" });
});

function audienceContext(draft) {
  return JSON.stringify({
    countries: draft.audience.countries.map(value => value.toUpperCase()),
    ageMin: draft.audience.ageMin, ageMax: draft.audience.ageMax, gender: draft.audience.gender,
    interestIds: draft.audience.interestRefs.map(value => value.id),
    placements: draft.placements.map(value => `${value.channel}_${value.surface}`),
    connectionId: draft.connectedAssets?.connectionId || null,
    adAccountId: draft.connectedAssets?.adAccountId || null,
  });
}

export const AdsDraftSchema = z.object({
  smartLinkCampaignId: z.string().uuid(),
  name: z.string().trim().min(1).max(180).default("Untitled Ads draft"),
  goal: z.enum(["song_growth", "release_growth", "fan_growth", "presave", "custom"]).default("song_growth"),
  sourceTrackId: z.string().uuid().nullable().default(null),
  selectedReleaseId: z.string().uuid().nullable().default(null),
  verifiedAudioReferenceId: z.string().uuid().nullable().default(null),
  creativeId: z.string().uuid().nullable().default(null),
  destinationId: z.string().uuid().nullable().default(null),
  connectedAssets: connectedAssets.nullable().default(null),
  estimatedAudience: estimatedAudience.nullable().default(null),
  genre: z.string().max(160).default(""),
  genreSource: z.enum(["ysong", "user"]).default("ysong"),
  dailyBudget: z.object({ minor: z.number().int().min(100).max(100000000), currency: z.string().regex(/^[A-Za-z]{3}$/) }).strict().default({ minor: 500, currency: "USD" }),
  schedule: z.object({ start: z.string().datetime().nullable(), end: z.string().datetime().nullable(), timezone: z.string().min(1).max(100) }).strict().default({ start: null, end: null, timezone: "UTC" }),
  placements: z.array(placement).min(1).max(6).default([{ channel: "facebook", surface: "feed" }]),
  audience: z.object({
    countries: z.array(z.string().regex(/^[A-Za-z]{2}$/)).max(250).default([]),
    ageMin: z.number().int().min(18).max(65).default(18),
    ageMax: z.number().int().min(18).max(65).default(65),
    gender: z.enum(["all", "male", "female"]).default("all"),
    interestRefs: z.array(z.object({ id: z.string().min(1).max(80), name: z.string().min(1).max(180) }).strict()).max(200).default([]),
  }).strict().default({}),
  copy: z.object({ text: z.string().max(2200), headline: z.string().max(255), language: z.string().max(20) }).strict().default({ text: "", headline: "Listen now", language: "en" }),
}).strict().superRefine((value, ctx) => {
  if (value.audience.ageMin > value.audience.ageMax) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["audience", "ageMax"], message: "Maximum age must be at least minimum age" });
  if (value.estimatedAudience && !value.connectedAssets) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["connectedAssets"], message: "Audience estimate requires connected assets" });
  if (!!value.schedule.start !== !!value.schedule.end || (value.schedule.start && new Date(value.schedule.end) <= new Date(value.schedule.start))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["schedule", "end"], message: "Schedule requires an end after its start" });
  if (new Set(value.placements.map(p => `${p.channel}_${p.surface}`)).size !== value.placements.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["placements"], message: "Placements must be unique" });
});

export function draftToStorage(input) {
  const placementTargets = input.placements.map(p => `${p.channel}_${p.surface}`);
  const platforms = [...new Set(input.placements.map(p => p.channel))];
  return {
    campaignId: input.smartLinkCampaignId, sourceTrackId: input.sourceTrackId, name: input.name, goal: input.goal,
    genre: input.genre, genreSource: input.genreSource, dailyBudgetMinor: input.dailyBudget.minor,
    currency: input.dailyBudget.currency.toUpperCase(), scheduleStart: input.schedule.start, scheduleEnd: input.schedule.end,
    timezone: input.schedule.timezone, placements: platforms,
    targeting: { countries: input.audience.countries.map(c => c.toUpperCase()), ageMin: input.audience.ageMin,
      ageMax: input.audience.ageMax, gender: input.audience.gender, interests: input.audience.interestRefs,
      placementTargets, platforms },
    adText: input.copy.text, adHeadline: input.copy.headline, language: input.copy.language,
    metaConnectionId: input.connectedAssets?.connectionId || null,
    metaAdAccountId: input.connectedAssets?.adAccountId || "",
    metaPixelId: input.connectedAssets?.pixelId || "",
    adsDraft: {
      selectedReleaseId: input.selectedReleaseId,
      verifiedAudioReferenceId: input.verifiedAudioReferenceId,
      creativeId: input.creativeId,
      destinationId: input.destinationId,
      connectedAssets: input.connectedAssets,
      estimatedAudience: input.estimatedAudience,
      estimatedAudienceContext: input.estimatedAudience ? audienceContext(input) : null,
    },
  };
}

export function storageToDraft(ad) {
  const t = ad.targeting || {};
  const saved = ad.metadata?.adsDraft || {};
  const targets = Array.isArray(t.placementTargets) && t.placementTargets.length ? t.placementTargets :
    (ad.placements || []).flatMap(channel => ["feed", "reels", "stories"].map(surface => `${channel}_${surface}`));
  const draft = {
    smartLinkCampaignId: String(ad.campaign_id), name: ad.name, goal: ad.goal,
    sourceTrackId: ad.source_track_id ? String(ad.source_track_id) : null,
    selectedReleaseId: saved.selectedReleaseId || null,
    verifiedAudioReferenceId: saved.verifiedAudioReferenceId || null,
    creativeId: saved.creativeId || null,
    destinationId: saved.destinationId || null,
    connectedAssets: saved.connectedAssets || null,
    estimatedAudience: saved.estimatedAudience || null,
    genre: ad.genre || "", genreSource: ad.genre_source || "ysong",
    dailyBudget: { minor: Number(ad.daily_budget_minor), currency: ad.currency },
    schedule: { start: ad.schedule_start ? new Date(ad.schedule_start).toISOString() : null,
      end: ad.schedule_end ? new Date(ad.schedule_end).toISOString() : null, timezone: ad.timezone || "UTC" },
    placements: targets.map(value => { const [channel, surface] = String(value).split("_"); return { channel, surface }; }),
    audience: { countries: t.countries || [], ageMin: t.ageMin ?? 18, ageMax: t.ageMax ?? 65,
      gender: t.gender || "all", interestRefs: (t.interests || []).map(({ id, name }) => ({ id, name })) },
    copy: { text: ad.ad_text || "", headline: ad.ad_headline || "", language: ad.language || "en" },
  };
  if (saved.estimatedAudienceContext !== audienceContext(draft) ||
    (draft.connectedAssets && (draft.connectedAssets.adAccountId !== String(ad.meta_ad_account_id || "") ||
      draft.connectedAssets.connectionId !== String(ad.meta_connection_id || "")))) draft.estimatedAudience = null;
  return draft;
}

export function projectAdsCampaign(ad, { smartLink = null, destinations = [], creatives = [], snippets = [] } = {}) {
  const draft = storageToDraft(ad);
  const submissionState = ad.status === "failed" ? "failed" : ad.status === "publishing" ? "submitting" : ad.meta_campaign_id ? "submitted" : "not_submitted";
  const reviewState = ["DISAPPROVED", "WITH_ISSUES"].includes(String(ad.meta_status).toUpperCase()) ? "rejected" :
    ad.status === "in_review" ? "pending" : ["active", "completed"].includes(ad.status) ? "approved" :
    ad.meta_campaign_id ? "unknown" : "not_requested";
  return {
    id: String(ad.id), ...draft, status: ad.status,
    sourceReleaseId: smartLink?.source_release_id ? String(smartLink.source_release_id) : null,
    audioSnippetIds: snippets.map(s => String(s.id)),
    creativeRefs: creatives.map(c => ({ id: String(c.id), status: c.status, selected: !!c.selected,
      audioSnippetId: String(c.audio_snippet_id) })),
    destinations: destinations.map(d => ({ id: String(d.id), platform: d.platform, label: d.label,
      url: d.url, kind: d.destination_kind, enabled: !!d.enabled, position: Number(d.position) })),
    metaSubmission: { state: submissionState, submittedAt: ad.meta_published_at || null,
      hasError: !!ad.meta_last_error?.message },
    review: { state: reviewState, checkedAt: ad.metadata?.metaDelivery?.refreshedAt || null },
    analytics: { href: `/api/tools/promotion/ad-campaigns/${ad.id}/analytics`,
      attributionCampaignId: String(ad.id), smartLinkCampaignId: String(ad.campaign_id) },
    provenance: { origin: "promotion", ownerUserId: String(ad.owner_user_id), genreSource: ad.genre_source || "ysong",
      createdAt: ad.created_at, updatedAt: ad.updated_at },
  };
}
