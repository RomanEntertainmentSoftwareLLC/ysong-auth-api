# Phase 23 — Promotion Center

Phase 23 is intentionally split into sub-phases. It is a music-focused campaign system, creative renderer, Smart Link attribution layer, and eventually a Meta paid-ad manager. Do not treat the presence of Meta helper code as proof that paid publishing is finished.

## Sub-phase map

- **23.1 — Campaign + Smart Link Core**
  - provider-neutral Smart Links and release landing pages
  - up to 100 destinations per campaign
  - platform catalog covering mainstream and regional music/video services, plus custom URLs
  - tracked visits, unique visitors, per-destination clicks, fan consent capture, QR codes, and SEO snapshots
- **23.2 — Ad Creative Studio**
  - select up to 3 snippets from the YSong master using a waveform
  - choose up to 5 uploaded background videos per render batch
  - cross-product generation (`audio clips × backgrounds`, maximum 15 renders per batch)
  - source background audio is discarded; only the selected song snippet is used
  - 1080×1920 9:16 and 1080×810 4:3 H.264/AAC outputs
  - preview, select/reject, retry, and reusable creative libraries
  - this phase is non-destructive and does not change the source master
- **23.3 — Audience + Campaign Setup** (next)
  - interests, country tiers/custom countries, age/gender/language, placements, schedule, budget, copy, cover art, live previews
- **23.4 — Real Meta Ads Publishing** (later)
  - Ad Account/Page/Instagram/Pixel selection and real Campaign → Ad Set → Creative → Ad creation
- **23.5 — Ads Analytics + Attribution** (later)
  - Meta spend/impressions/reach/CPC/CTR/video metrics joined to YSong Smart Link behavior
- **23.6 — Promotion Intelligence** (later)
  - recommendations only; YSong must never silently spend money or alter targeting

## Creative rendering contract

The Promotion renderer uses deterministic FFmpeg. It is **not an AI video generator**.

- The selected background video's original audio stream is never mapped into the output.
- The song snippet is decoded and trimmed with `atrim` before encoding.
- YSong does not loudness-normalize, compress, master, or otherwise silently alter the source master for the ad.
- Video is center-cropped after aspect-fill scaling.
- Outputs are H.264 (`libx264`) + AAC, 48 kHz stereo, 30 fps, `yuv420p`, and fast-start MP4.
- Failed multi-format renders clean up partial output files.
- The current queue is a safe, sequential in-process pre-alpha worker. A dedicated render worker can replace it later without changing the campaign/creative schema.

### Runtime requirements

`ysong-auth-api` must have FFmpeg and FFprobe available. The Docker image installs FFmpeg on Alpine, and the VM deployment workflow installs FFmpeg through apt.

Optional server variables:

- `FFMPEG_PATH=ffmpeg`
- `FFPROBE_PATH=ffprobe`
- `PROMOTION_FFMPEG_PRESET=medium`
- `PROMOTION_FFMPEG_CRF=20`
- `PROMOTION_RENDER_TIMEOUT_MS=600000`

`GET /api/tools/promotion/health` reports whether FFmpeg, `libx264`, and the AAC encoder are available so the web UI can disable rendering rather than pretending it will work.

## Smart Link behavior

A paid ad's CTA is designed to point to the YSong Smart Link rather than one streaming service. The fan then chooses a destination. This allows YSong to attribute downstream choices such as Spotify, Apple Music, YouTube Music, TIDAL, Amazon Music, FLO, Bilibili, Rumble, BitChute, or a custom service URL.

The platform catalog is a convenience list, not a whitelist. Artists can enter custom providers.

## Honest pre-save behavior

Promotion Center provides the pre-save campaign/funnel, fan capture, pre-save destination buttons, and `presave_intent` analytics. It does **not** claim to mutate a fan's Spotify/Apple library unless a provider-authorized save API is connected.

## Existing Meta connection

The existing Meta OAuth connection remains server-side. Provider tokens stay encrypted and no Meta secret is shipped in `ysong-web` or Bridge. Phase 23.2 does **not** spend money or create paid Meta campaigns. The creative studio can therefore be exercised safely before 23.3/23.4 are enabled.

Production Meta actions require public HTTPS URLs; Meta cannot fetch localhost assets.

## Phase 23.3.1 - Live Meta Interest Explorer

Audience interest selection now behaves as a live Meta targeting explorer rather than a free-form keyword box.

- After 2 typed characters, ysong-web waits 300ms and queries the server.
- ysong-auth-api performs the authenticated Meta `type=adinterest` lookup.
- Up to 50 real Meta interest objects are returned per search.
- Each result can include Meta's lower/upper estimated audience-size bounds and taxonomy path.
- Only selected Meta interest IDs are eligible for paid-ad targeting.
- Phase 22 / YSong genre and tag suggestions are search seeds only. They are never silently treated as Meta targeting IDs.
- Selected audience-size values are kept for draft UI display, but Meta publishing only sends the verified interest ID/name pair.

## Phase 23.3.1 - Stock Video Provider Foundation

Creative Studio can search licensed stock footage without YSong copying a provider's whole catalog.

### Pexels provider

Set `PEXELS_API_KEY` only on `ysong-auth-api`.

- Search endpoint: `GET /api/tools/promotion/stock/videos`
- Import endpoint: `POST /api/tools/promotion/stock/videos/import`
- Search is server-side and cached for 10 minutes to reduce provider API traffic.
- Portrait results are requested for Reel/Story workflows.
- Only videos 60 seconds or shorter are offered.
- Search results link back to Pexels and identify the contributor.
- A stock clip is downloaded into YSong storage only after the user explicitly clicks Import.
- Imports are size-capped (250 MiB by default) and re-probed before being registered as campaign backgrounds.
- YSong then treats the imported clip exactly like a user-uploaded background: original stock audio is discarded when the song snippet is rendered over it.

The stock module is deliberately provider-oriented so Pixabay, Storyblocks, Shutterstock, or other properly licensed catalogs can be added without changing the Creative Studio render pipeline.

## Phase 23.4 - Real Meta Paid-Ad Publishing

Phase 23.4 crosses the paid-ad boundary. YSong can now create the real Meta hierarchy for a reviewed YSong ad campaign:

`Campaign -> Ad Set -> Ad Creative(s) -> Ad(s)`

The paid CTA points to the YSong Smart Link, never directly to one streaming platform. Each selected creative receives its own tracked Smart Link URL (`utm_source=meta`, `utm_medium=paid_social`, campaign ID, and creative ID) so later attribution can join Meta delivery to YSong destination clicks.

### Safety contract

Paid publishing is explicit and fail-closed:

- Preflight checks the Smart Link, enabled destinations, selected/ready creatives, public HTTPS URL, Meta connection, Ad Account state/currency, Instagram linkage, geography, placements, budget, and EU/EEA DSA disclosure.
- Preflight produces a SHA-256 fingerprint of the exact reviewed campaign, Smart Link state, destinations, and selected creative object keys.
- Publish is rejected if that fingerprint changes after review.
- Four explicit acknowledgements are required: settings reviewed, media rights, Meta billing, and spend authorization.
- Active publishing additionally requires the user to type `PUBLISH`.
- A draft Smart Link is never activated silently; the user must explicitly approve activation.
- Meta objects are created PAUSED first. For active publishing, Ads are activated first, then the Ad Set, then the Campaign. The paused parent prevents delivery during partial activation.
- Pausing reverses that safety order by pausing the Campaign first, then descendants.
- Resuming paid delivery requires the user to type `RESUME`.
- Deleting a failed/paused remote Meta draft requires `DELETE`. YSong source assets and campaign configuration remain intact.
- Partial Meta creation is persisted progressively so a failure can be inspected and the remote draft can be cleaned up rather than orphaned silently.

### Placement-aware creative mapping

YSong preserves the Creative Studio renders rather than asking Meta to silently remake them:

- Feed placements use the 4:3 render.
- Reels and Stories use the 9:16 render.
- When a campaign uses both placement groups, one Meta Ad Creative uses placement asset customization rules to map the correct video to each placement.
- Meta standard creative enhancements are explicitly opted out so an artist-approved render is not silently transformed by YSong's integration.
- The preferred CTA is `LISTEN_NOW`; if Meta rejects that CTA for the current account/objective combination, YSong retries creative creation with `LEARN_MORE` rather than failing the entire campaign for CTA compatibility.

### EU/EEA DSA disclosure

When targeting EU/EEA countries, preflight requires beneficiary and payor disclosure. YSong reads the selected Meta Ad Account's defaults when Meta supplies them and lets the artist review/override those values before publish.

### Meta permissions / deployment

The Meta connection requests Page/Instagram scopes plus `ads_read`, `ads_management`, and `business_management`. Existing connections created before the paid-ad scopes were added may need to reconnect before Ad Accounts can be enumerated or paid campaigns created. Production use is also subject to Meta App Review / access level requirements.

Optional server setting:

- `META_PROMOTION_CTA=LISTEN_NOW` (falls back to `LEARN_MORE` if Meta rejects the preferred CTA while creating the ad creative)

Phase 23.4 intentionally does not implement the Phase 23.5 analytics dashboard yet. Status refresh exists now; spend, reach, CTR/CPC, video-view metrics, and joined YSong/Meta attribution are the next sub-phase.

## Phase 23.5 - Ads Analytics + Attribution

Phase 23.5 joins Meta delivery metrics with YSong's first-party Smart Link behavior.

### Meta Insights

For a published Meta campaign YSong can request and cache:

- spend
- impressions / reach / frequency
- clicks / link clicks / outbound clicks
- CPC / CPM / CTR
- landing-page views when Meta exposes them
- video plays, ThruPlays, and 25/50/75/100% watch milestones when available
- daily campaign rows
- Ad Set and Ad rows
- publisher-platform / platform-position breakdowns
- country breakdowns

The server retries a core Insights field set if a Meta account/API version rejects an optional video metric so one missing video field does not destroy the whole report.

Meta snapshots are cached in `promotion_meta_insights` for 10 minutes by default. The analytics UI can force a refresh. If a refresh fails and a same-range cached snapshot exists, YSong marks the report stale and continues using the cached Meta numbers instead of silently presenting them as live.

### YSong first-party attribution

The paid creative URL contains the local YSong ad campaign ID and creative ID. The public Smart Link records those identifiers on:

- landing-page views
- destination clicks
- pre-save intent clicks
- fan email captures
- other attributed conversion events

This lets YSong report the downstream behavior for each rendered creative rather than stopping at Meta's click count.

Examples of derived metrics:

- cost per Smart Link visit
- Smart Link engagement rate
- cost per streaming/platform click
- cost per fan email capture
- Meta outbound-click -> YSong Smart Link arrival rate
- per-destination click share and cost
- creative-by-creative spend, impressions, Meta outbound clicks, Smart Link views, destination clicks, and engagement

The dashboard also surfaces placement and country breakdowns and a current best-performing creative/destination using observed data. It does not automatically pause ads or shift budget; optimization remains a user decision until a later intelligence phase explicitly adds recommendation/approval workflows.

## Phase 23.6 - Promotion Intelligence

Phase 23.6 is an advisory optimization layer over Phase 23.5 analytics. It is intentionally deterministic in this phase: no learned model is claimed, and no campaign setting is changed automatically.

### Evidence model

Promotion Intelligence combines the two evidence domains without pretending they have identical granularity:

- Meta Insights supplies spend, delivery, outbound-click, placement, country, and video-view evidence.
- YSong first-party attribution supplies Smart Link visits, destination clicks, fan emails, conversions, and creative IDs.
- Creative, audio-snippet, and background-video comparisons can therefore use end-to-end spend -> YSong outcome evidence.
- Placement and country comparisons remain Meta-side outbound-efficiency recommendations because YSong cannot truthfully assign a later Spotify/Apple/TIDAL choice to a Meta placement or country with the current attribution granularity.

### Minimum evidence / confidence

The engine uses evidence gates instead of declaring tiny samples winners. Recommendations include:

- low / medium / high confidence
- low / medium / high priority
- the observed evidence that triggered the recommendation
- the entity being discussed (campaign, funnel, creative, snippet, background, placement, country, destination)
- a suggested controlled test, not an automatic action

When a campaign has insufficient paid-delivery or downstream traffic, the valid output is a `learning` recommendation instructing the artist to collect more evidence.

### Recommendation families

The deterministic v1 engine can surface:

- Meta outbound -> Smart Link arrival-drop warnings
- Smart Link engagement strength/weakness
- end-to-end creative winners and underperformers
- audio-snippet performance aggregated across multiple backgrounds
- background-video performance aggregated across multiple snippets
- Meta-side placement efficiency comparisons
- Meta-side country efficiency comparisons
- dominant downstream destination affinity
- possible creative-fatigue warnings from frequency + recent-vs-early daily click efficiency

Campaign goal changes the preferred downstream objective. Song/release growth prioritizes platform clicks; fan growth prioritizes email captures; pre-save prioritizes confirmed conversions and falls back only when the primary signal has no observations.

### Guardrail

Promotion Intelligence is advisory only. It never pauses/resumes ads, changes audiences, changes countries/placements, edits creative selection, or moves budget. Any future action workflow must require a separate explicit artist approval and should preserve the recommendation evidence that was reviewed.
