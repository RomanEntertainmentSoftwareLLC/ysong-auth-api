# Promotion and Meta backend architecture

This is the repository map for future Ads work. The existing Promotion Center is the sole owner of Smart Link and paid-ad campaign behavior; extend it instead of introducing a parallel promotion backend.

## Ownership and persistence

- `src/index.js` registers `registerPromotionRoutes` and injects authenticated-user and owned-object/file helpers. At startup it calls `ensurePromotionSchema()` before listening.
- `src/promotion/schema.mjs` is the authoritative persistence definition (idempotent runtime PostgreSQL DDL), and `src/promotion/routes.mjs` owns request validation, authorization, orchestration, and response mapping. PostgreSQL access uses the shared `pool` in `src/db.js`.
- `promotion_campaigns`, `promotion_destinations`, `promotion_fans`, and `promotion_events` own Smart Link configuration and first-party funnel events. `promotion_ad_campaigns` references its Smart Link via `campaign_id`; `promotion_audio_snippets`, `promotion_background_videos`, `promotion_creative_libraries`, and `promotion_ad_creatives` own the ad creative pipeline. `promotion_meta_insights` caches Meta snapshots. Meta connection/profile/OAuth-state tables own the account linkage and selected account settings.
- `world_releases` and `world_tracks` remain release/master sources, not Promotion-owned copies. Media bytes are stored through the injected object-storage helpers; Promotion rows keep object keys and metadata. The current injected implementation is local filesystem storage configured by `LOCAL_STORAGE_DIR` (see `src/index.js`).

## Routes and flow

All authenticated product routes use `/api/tools/promotion` and `requireAuth`. Smart Link campaign CRUD, status, analytics, fans, SEO refresh, and legacy organic `campaigns/:id/meta-publish` are in `src/promotion/routes.mjs`. Public landing, artwork, QR, event, fan-capture, and redirect routes are `/api/promotion/public/:slug...` and `/api/promotion/r/:slug/:destinationId`.

Paid-ad setup and orchestration use `/api/tools/promotion/ad-campaigns`: CRUD, snippets, creatives, background-video libraries, render/retry, Meta preflight/publish/refresh/status/discard, analytics, and intelligence. `/meta/ad-accounts`, `/meta/pixels`, and `/meta/interests` support setup. The authenticated `/meta/status`, `/meta/oauth/start`, `/meta/select`, and `/meta/disconnect` routes manage the shared connection; the OAuth callback is `/api/tools/promotion/meta/oauth/callback`.

`GET /meta/assets` returns the selected connection's Page and linked Instagram identity, accessible ad accounts and their business references, and optional Pixel references when `adAccountId` is supplied. `POST /meta/assets/select` takes `connectionId`, `adAccountId`, and optional `pixelId`; it checks the live Meta discovery results before saving those references to `promotion_meta_profiles`. A connected user's accessible ad account may be personal and have no business ID. The response contains IDs and display names only. `dataSources` can model datasets at the adapter boundary, but dataset discovery and selection are not enabled until a supported Meta API flow is verified. Paid preflight rechecks the selected ad account and Pixel. Meta owns ad spend and billing; YSong does not collect or store payment credentials.

Meta's official [Marketing API collection](https://www.postman.com/meta/facebook-marketing-api/collection/0zr4mes/facebook-marketing-api-mapi) documents user access tokens, ad account IDs, permissions, and collection pagination. Its [onboarding collection](https://www.postman.com/meta/facebook-marketing-api/collection/9jo4f5y/mapi-onboarding) requires advertiser access to the business portfolio, ad account, and related Page, Instagram, and Pixel assets. The existing OAuth callback and Graph adapter are retained; production use requires the appropriate Meta app access and the user's grant. The asset discovery code follows cursor pagination so accounts or Pages after Meta's first page are visible.
For a configured Facebook Login for Business flow, set `META_BUSINESS_LOGIN_CONFIG_ID`; the OAuth start URL uses that configuration instead of a requested `scope` list. The Meta app's configuration must grant the Page, Instagram, ad account, and Pixel assets needed by the selected workflow. Without it, the existing scope based Facebook Login flow remains available.

`promotion/meta.mjs` is the reusable Meta integration boundary: OAuth and Graph API transport, connection selection, Pages/Instagram/ad-account/pixel/interest discovery, organic publishing, targeting/placement payload construction, paid Campaign -> Ad Set -> Creative -> Ad creation, status/deletion, and Insights retrieval. `creative.mjs` handles deterministic FFmpeg rendering; `stock.mjs` is the server-side Pexels adapter. Route orchestration fingerprints reviewed publish inputs, persists remote IDs progressively, and applies explicit confirmation/status ordering. Keep spend authorization and remote Meta writes behind these existing routes and helpers.

## Secrets and analytics

`META_APP_ID`, `META_APP_SECRET`, and `META_TOKEN_ENCRYPTION_KEY` are server-only configuration. `promotion/crypto.mjs` encrypts user/page access tokens with AES-256-GCM; ciphertext is stored in `promotion_meta_connections`. `meta.mjs` decrypts tokens only server-side for Graph requests. Never return token fields, put secrets in client configuration, or persist plaintext tokens. `PEXELS_API_KEY` and render/runtime settings are likewise server-side.

First-party Smart Link attribution records ad campaign and creative IDs in event metadata and fan metadata. Paid analytics joins those events to cached Meta delivery rows (`promotion_meta_insights`); the route computes the envelope and intelligence from these owners. Extend the existing attribution/caching path when adding metrics so reporting remains joined to the same campaign and creative IDs.

## Implementation rule

Before adding Ads behavior, inspect `src/promotion/schema.mjs`, `routes.mjs`, and `meta.mjs`; add compatible fields/flows there, preserve the Smart Link foreign-key relationship, and keep credentials inside the API. `docs/phase23_promotion_center.md` records product behavior and safety contracts; this note identifies code and data ownership.
