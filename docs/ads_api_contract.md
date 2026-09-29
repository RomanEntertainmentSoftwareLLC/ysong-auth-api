# Ads campaign API contract (v1)

Ads uses the existing Promotion tables and authenticated `/api/tools/promotion` router. The new `/ads/campaigns` surface is a small product contract over `promotion_ad_campaigns`; it does not own a second campaign, destination, creative, audio, or analytics store. All routes require the same `requireAuth` owner check as Promotion.

## Routes

| Method | Path | Result |
| --- | --- | --- |
| GET | `/ads/campaigns` | `{ campaigns: AdsCampaign[] }`, newest updates first |
| GET | `/ads/campaigns/:id` | `{ campaign: AdsCampaign }` or 404 |
| POST | `/ads/campaigns` | Create a local draft from `AdsDraft`; returns `{ campaign }` (201) |
| PATCH | `/ads/campaigns/:id` | Merge draft fields; returns `{ campaign }`. Only local `draft`, `ready`, or `failed` campaigns without a remote campaign can be changed (409 otherwise). |

`AdsDraft` has `smartLinkCampaignId`, `name`, `goal`, optional `sourceTrackId`, `genre`, `genreSource`, `dailyBudget: { minor, currency }`, `schedule: { start, end, timezone }`, `placements: [{ channel, surface }]`, `audience: { countries, ageMin, ageMax, gender, interestRefs: [{ id, name }] }`, and `copy: { text, headline, language }`. `channel` is `facebook` or `instagram`; `surface` is `feed`, `reels`, or `stories`. Budget is in the currency's minor units. A schedule needs both dates, with end after start. POST requires `smartLinkCampaignId`, `name`, `dailyBudget`, and at least one placement. Unknown fields, including provider submission objects, are rejected. PATCH merges the nested budget, schedule, audience, and copy objects; it cannot change the Smart Link owner.

`AdsCampaign` contains the draft fields plus `id`, local `status`, `sourceReleaseId`, `audioSnippetIds`, `creativeRefs` (`id`, `status`, `selected`, `audioSnippetId`), Smart Link `destinations` (`id`, `platform`, `label`, `url`, `kind`, `enabled`, `position`), `metaSubmission` (`state`, `submittedAt`, `hasError`), `review` (`state`, `checkedAt`), `analytics` (`href`, `attributionCampaignId`, `smartLinkCampaignId`), and `provenance` (`origin`, `ownerUserId`, `genreSource`, `createdAt`, `updatedAt`). Submission state is `not_submitted`, `submitting`, `submitted`, or `failed`. Review state is `not_requested`, `pending`, `approved`, `rejected`, or `unknown`; paused remote campaigns with no review evidence are `unknown`.

`sourceReleaseId` comes from the linked Smart Link's `world_releases` reference; `sourceTrackId` and `audioSnippetIds` point to existing YSong master/snippet records. `creativeRefs` point to existing rendered creatives. Destinations are owned by the Smart Link and edited through its existing campaign routes. Analytics remains at the `analytics.href` route and joins Meta snapshots with first-party Smart Link attribution. The API does not copy or embed media, insights snapshots, Meta object IDs, account credentials, or Graph payloads in this contract.

Draft creation and editing do not submit ads or authorize spend. The existing `/ad-campaigns/:id/meta/preflight`, `/meta/publish`, `/meta/refresh`, `/meta/status`, and `/meta/discard` routes retain review, explicit confirmation, remote operations, and provider details. Existing `/ad-campaigns` responses remain available for current clients. No migration is needed; the runtime Promotion schema and existing foreign keys remain authoritative.
