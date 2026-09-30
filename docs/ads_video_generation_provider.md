# Future Ads video generation provider boundary

`src/promotion/video-generation.mjs` defines the shared request, normalized job result, and adapter registry for future Promotion/Ads creative jobs. No generation provider or route is registered yet. The existing FFmpeg creative queue in `creative.mjs` and stock footage adapter in `stock.mjs` continue to serve their current purposes.

## Request and job shape

`VideoGenerationRequestSchema` accepts an aspect ratio (`9:16`, `4:3`, `1:1`, or `16:9`), integer duration in seconds (1–120), prompt, up to eight YSong asset references, and up to 24 timing cues. A reference has `kind` (`image`, `video`, `audio`), `objectKey`, and `role` (`style`, `subject`, `motion`, `soundtrack`). A timing cue has `atSeconds` within the requested duration and an `instruction`. Unknown and vendor-specific fields are rejected. An adapter can reject unsupported combinations through its eligibility check.

Adapters return `VideoGenerationJobSchema`: opaque `providerJobId`, `status` (`queued`, `running`, `succeeded`, `failed`, `canceled`), nullable `output`, and nullable `errorCode`. A successful output is a YSong-stored MP4 object key with duration and dimensions. Provider URLs, credentials, and raw payloads are not part of the shared result.

## Adapter contract

Register an adapter with a stable `id` and these asynchronous methods:

- `checkEligibility({ request, context })` returns `{ eligible: true }` or `{ eligible: false, reason }`. This provider-specific gate must verify official API access and that the intended commercial Ads use is permitted, as well as model, format, and account limits. The registry calls it before `submit`.
- `submit({ request, context })` submits through the authorized provider API and returns a normalized job. It must arrange ingestion of any completed video into YSong-owned object storage before reporting `succeeded`.
- `poll({ providerJobId, context })` returns the current normalized job with the same ID. The adapter handles provider authorization and transport for polling.

`context` is an opaque server-side value for the adapter and orchestrator; it should carry owner and authorization information, never be accepted directly from a client. A future authenticated Promotion route must verify campaign ownership, reference asset ownership and rights, and output ownership before calling this registry or attaching an output to `promotion_ad_creatives`. It must retain the existing audio, creative review, and Meta publishing gates. The registry itself performs no network calls, persistence, scheduling, or license determination.

Aggregator, direct-provider, and local/open-model implementations can each implement this contract. Each adapter owns its credentials, official API and commercial eligibility checks, provider-specific request mapping, error mapping, and output ingestion. Consumer website automation and private endpoint scraping are outside this boundary.
