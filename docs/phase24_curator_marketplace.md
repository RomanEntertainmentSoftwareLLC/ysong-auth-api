# Phase 24 — Curator Marketplace

YSong Curator Marketplace connects artists with independent playlist, blog, radio, YouTube, influencer, and music-media curators.

## Editorial policy

Marketplace credits purchase review consideration only. They never buy acceptance, playlist placement, coverage, publication, ranking, or a favorable review. Curators retain independent editorial control. `accepted` and `placement_status=published` are separate states by design.

## Matching

A reusable match context combines:

- World release / track metadata
- optional Phase 22 Audio Intelligence handoff (no second CLAP pass)
- one SEO Intelligence snapshot
- curator-declared genres, moods, sonic tags, BPM range, and explicit-content policy
- curator response behavior

The resulting 0–100 score is an editorial-fit score, not an acceptance probability.

## Credits

Phase 24 provides an internal atomic credit ledger. During beta, `CURATOR_BETA_STARTER_CREDITS` may seed clearly labeled non-cash courtesy credits once per user. A purchase-provider integration is not faked. If a curator misses their declared response deadline, the submission expires and review credits are refunded. An artist can also withdraw a still-unopened submission for a refund.

## Curator quality signals

YSong tracks response rate, historical acceptance rate, average response time, sample-size confidence, and a response-behavior reputation signal. Historical acceptance remains descriptive and is not treated as a guarantee or an "easy curator" ranking.

## Main endpoints

- `GET /api/curators/health`
- `GET /api/curators/wallet`
- `GET/PUT /api/curators/profile`
- `POST/PATCH/DELETE /api/curators/channels/:id?`
- `POST /api/curators/match-context`
- `GET /api/curators/recommendations`
- `POST /api/curators/submissions`
- `GET /api/curators/submissions`
- `GET /api/curators/desk/submissions`
- `POST /api/curators/desk/submissions/:id/open`
- `POST /api/curators/desk/submissions/:id/respond`
- `POST /api/curators/desk/submissions/:id/placement`
- `POST /api/curators/reports`
