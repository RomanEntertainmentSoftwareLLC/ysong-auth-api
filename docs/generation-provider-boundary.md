# Audio generation provider boundary

`src/generation/provider-boundary.mjs` defines the internal job contract for song, audio, MIDI, multitrack and vocal generation. A provider advertises output formats and whether it supports polling or cancellation, then supplies server-side `submit`, optional `poll`, and optional `cancel` functions. The planner and chat AI paths are separate and must not be registered as audio providers.

The current Cloudflare AI Gateway MiniMax Music 2.6 path and local audio.cpp MiniMax Music 3 path are synchronous song/audio implementations. Their existing authenticated route and execution behavior remain intact. Future private Music 3 or YSong vocal providers can implement the same contract under their own IDs; neither MiniMax nor Cloudflare is a permanent job identity. No new consumer route is enabled by this module.

The job projection exposes status, input provenance identifiers, owned artifacts, provider and model version, a reported or estimated cost with currency, cancellation state, and safe error codes. Unknown costs remain `null`; estimates must never be presented as reported charges. Provider credentials, upstream URLs, prompts, raw errors, and provider response bodies remain on the server. Artifacts become public job references only after storage under an owned `user-uploads/` key. Existing SaaS generation versions use this projection while retaining their current progress and retry fields.

Before enabling an asynchronous or paid provider, its adapter must persist the provider request identity and state before submission, define polling and cancellation semantics, reconcile reported cost, and handle uncertain submissions without automatic replay. Authorization, quota and provider controls stay at the server boundary.
