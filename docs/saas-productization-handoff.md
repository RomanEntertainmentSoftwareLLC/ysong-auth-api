# YSong SaaS productization handoff — 2026-10-02

## Scope and release state

This is a locally validated Priority 1 foundation, **not a completed SaaS launch**. `SAAS_ENABLED` remains absent/disabled in the existing environment; `.env.example` explicitly uses `0`. No production migration, billing configuration, deployment, commit, push, or paid AI/music call was performed. Existing dirty Cloudflare/R2 work was retained. Foreman/control-plane were not operated on. Autopilot was not started or modified.

The original music providers and binary response contract remain intact. SaaS-enabled standalone music requests gain durable output storage, provenance, quota accounting and optional response headers. **Pass 2 now supplies server-owned whole-session batches for Create Song, charging one unit per usable version rather than per stem.** The browser executor remains the legacy path while SaaS is disabled. The following Pass 1 sections are a historical snapshot; the Pass 2 addendum below supersedes its orchestration/project/history gaps. Do not enable public billing before the remaining launch gates are satisfied.

## Audited existing foundations

- UUID users, Neon auth, email verification/reset and existing terms acceptance fields.
- `user_client_state` mirrors existing browser project state; there is no separate relational projects table. No replacement project-state owner was introduced.
- Existing generation library, immutable version lineage, partial recovery, strict multitrack result contract, independent DAW imports, MIDI/VST editing, project autosave and export panel were reused/preserved.
- Existing Content Rights Gate, recording-fingerprint foundations, Ads attestation, notifications and stock-media provenance remain intact. Backlog DONE labels were cross-checked with current source/tests; they were not treated as proof that the new SaaS requirements were already implemented.
- No billing SDK, subscription tables, entitlement service or quota system existed before this pass. Stripe's official server SDK was added; application entitlements remain provider-neutral.
- Read-only Neon schema inspection confirmed `users.id` and `user_client_state.user_id` are UUIDs. No production schema writes were made.

## Implemented

### Authoritative account and quota foundation

The additive SQL migration creates four plan records (Free, Basic, Pro, Premium), account access/roles, billing references/status/periods/cancellation state, expiring comp overrides, quota periods, generation batches/versions, billing event journal, admin audit and provider controls. Prices, capabilities and quotas are deliberately unconfigured; NULL quota means unconfigured, not unlimited. Repeating the migration preserves configuration and data.

Bootstrap resolves the requested email into a stored superadmin UUID once, only when no superadmin role exists. Subsequent requests and migrations preserve that identity even after its email changes; another user acquiring the old email is not promoted. Superadmin bypasses plan/quota charging, while emergency provider controls still apply.

The shared service validates integer quantity 1–20; reservations, request idempotency, parent ownership, independent version/project IDs and quota updates share a transaction. Account row locks serialize reservations and conditional quota updates prevent concurrent overspending. UTC calendar-month periods are immutable accounting buckets, independent of subscription billing-period timestamps; late reconciliation affects the original bucket. True failure releases once; ready/partial usable work consumes once. Disliking output and retrying reconciliation cannot refund consumed units.

Batch reservation is an internal executor API, not an exposed public button promising twenty runnable versions. No public route lets clients declare work successful, failed or refundable. Queued versions can be cancelled by their owner; started/completed versions cannot be refunded by client cancellation.

### Billing and administration

- Stripe-hosted Checkout uses server-configured prices, server-owned customer IDs and idempotency keys. Test/live key modes and customer references are separated. Already active subscriptions reject a second checkout. Superadmin does not purchase access.
- Raw webhook bytes are verified with the official SDK before JSON parsing. Wrong signatures, stale signatures and test/live mismatches are rejected. Event journal inserts and normalized entitlement changes commit together; duplicates are harmless, older events do not overwrite newer state, and current subscription state is retrieved for updates. Unknown prices/customers and conflicting multiple subscriptions require configuration/review rather than granting arbitrary access. Role and comp fields are never changed by billing events. Safe before/after plan/status transitions are journaled without raw webhook payloads or secrets.
- Server-authorized account search; audited suspend/ban/restore, generation/upload disable/re-enable, session revocation, notes and expiring/permanent plan/quota comp overrides. Superadmin targets are protected against ordinary admin changes/self-ban.
- Admin audit read endpoint and reason-required global/per-provider controls.
- Private owner-scoped generation history and thumbs up/down API; feedback never affects consumed quota.
- Discreet plan/quota/upgrade card in Create Song; account administration in existing Settings. These render only when the server explicitly reports SaaS enabled. No client plan claims authorize anything.

### Generation/provider integration

- Optional account-state/session-revocation checks in existing auth middleware; generation/upload capability gates precede supported route execution.
- `/api/music/generate` reserves one standalone render, records its version before execution, records the actual configured provider/model, saves output through the existing R2/local storage boundary before declaring it ready, persists audio SHA-256/object key/bytes/content type and reconciles quota before sending the normal binary audio.
- Server-saved audio can be reused by the existing frontend upload helper, avoiding a redundant upload. Its cache is bound to the authenticated account token; legacy responses still upload as before.
- The binary endpoint explicitly rejects quantity other than 1 in SaaS mode. Batch execution is not silently reduced to a single render.
- Other metered generation executors are not fully integrated yet: normal accounts receive an explicit 503 in SaaS mode instead of bypassing reservations. Superadmin can exercise existing tools. Assistant endpoints use configured capabilities and provider controls; their own token/cost metering remains future work.
- Global/OpenAI controls cover the shared OpenAI call boundary; route gates cover Cloudflare/local/legacy music and artwork. No provider fallback or silent model change was added.

### DAW

- Top-left visible Export button and File → Export use the same `openExportPanel` and existing renderer. No new export engine or ads were introduced. Existing formats remain available; new stem export/quality options were not invented.
- Automatic E follows actual audio clip extent, MIDI notes and in-region MIDI automation, including additions/trims/deletions. Empty projects start at bar 2. The old fixed 65 default is retired.
- Dragging E makes it manual; Auto E restores tracking. Mode persists with the existing project and undo/redo snapshots. Deliberate non-default legacy endpoints are preserved; legacy 65 endpoints become automatic because old files cannot distinguish the old default from a deliberately chosen 65. Newly saved manual 65 endpoints retain their explicit mode.
- The duration helper accepts measured tail padding. Automatic effect-tail measurement is not yet integrated; use manual E for a deliberate render tail.

## Exact files changed in this pass

Paths below are relative to the named canonical repo. Other previously dirty files were left intact.

### D:\YSong\ysong-auth-api

Modified:

- `.env.example`
- `package.json`
- `package-lock.json`
- `src/index.js`
- `cloudflare/worker.js` — future runtime configuration allowlist only
- `cloudflare/deploy.mjs` — future deployment configuration allowlist only
- `test/cloudflare_music.test.mjs` — repaired pre-existing multiline route extraction; added persistence coverage

Added:

- `src/saas/schema.sql`
- `src/saas/service.mjs`
- `src/saas/billing.mjs`
- `src/saas/routes.mjs`
- `scripts/migrate-saas.mjs`
- `test/saas.test.mjs`
- `docs/saas-productization-handoff.md`

### D:\YSong\ysong-web\ysong

Modified:

- `src/lib/musicGeneration.ts`
- `src/tabs/CreateSong.tsx`
- `src/tabs/DAW.tsx`
- `src/tabs/SettingsPane.tsx`
- `tests/generatedDawImport.test.mjs` — retains existing assertions and now verifies automatic marker mode

Added:

- `src/components/AccountPlan.tsx`
- `src/lib/dawDuration.ts`
- `tests/dawDuration.test.mjs`
- `tests/musicGenerationPersistence.test.mjs`

Bridge/vocal/critique repos were not changed. The web build regenerated ignored `dist` artifacts. Isolated test schemas were retained in a dedicated local PostgreSQL container; it was stopped after validation, not deleted. Full lint diagnostics are in `D:\YSong\.logs\saas-web-lint.json` outside the source repos.

## Migration and environment

The migration is explicit: review `src/saas/schema.sql`, confirm the intended database and backup/recovery plan, then run `node scripts/migrate-saas.mjs --apply` from the auth repo. It uses a transaction and advisory lock. It never runs during application startup. **It has not been applied to Neon production.** Running this command with the current `.env` would target that configured database; do not use it casually for tests.

New server-only configuration:

- `SAAS_ENABLED=0` — keep disabled until remaining executor/billing rollout gates pass.
- `BILLING_MODE=test` or `live`, explicitly matching keys/webhooks/customer data.
- `STRIPE_SECRET_KEY` — blank example; separate test/live secrets.
- `STRIPE_WEBHOOK_SECRET` — blank example; matching endpoint secret.
- `BILLING_RETURN_URL` — trusted server-owned return URL.

Reused: `DATABASE_URL`, `PGSSL`, `JWT_SECRET`, existing token TTL, R2 endpoint/bucket/credentials, Cloudflare account/token/model/provider configuration, OpenAI and existing audio.cpp/legacy provider settings, frontend API base URLs. No new browser secrets or browser billing price IDs were added. `TEST_SAAS_DATABASE_URL` is a test-only variable guarded to the loopback `ysong_saas_validation` database, not a production variable.

Plan configuration stays in Neon: `monthly_generation_quota`, explicit `capabilities` (generation/assistant/artwork/uploads), and `billing_prices` with separate `stripe:test` / `stripe:live` price references. No prices or commercial quotas were guessed. The 20-unit values in tests are fixtures only.

Human setup after executor integration:

1. Choose authoritative plan prices, quotas and capabilities. Create matching recurring products/prices in the correct Stripe mode, configure the plan records, then review normal-account access.
2. Configure the server secrets and trusted return URL. Register `/api/billing/webhook` for `customer.subscription.created`, `updated`, and `deleted`; exercise signed test events before considering live mode. Verify retries, payment failure and cancellation in sandbox.
3. Enable Link in Stripe payment-method settings where eligible. Hosted Checkout supports it; no Link-specific entitlement logic is needed. See [official Link documentation](https://docs.stripe.com/payments/link).
4. Add customer subscription-management/cancellation UX and finish conflicting-subscription handling before selling access.
5. For OpenAI, the account owner chooses auto-recharge threshold, recharge amount/restored balance and monthly recharge limit in the API organization's billing dashboard. These are separate from YSong usage controls; no amounts were chosen here. See [official prepaid billing guidance](https://help.openai.com/en/articles/8264644-setting-up-and-managing-prepaid-api-billing).

## Validation results

Before changes: web 102/102 tests passed. API 69/71 passed on Windows: a pre-existing Cloudflare test extractor missed the multiline route (404 instead of the expected 401), and the ffmpeg test could not find ffmpeg. The route extractor was repaired without weakening its assertions. The audio test was retained and passed in the existing ffmpeg-equipped image.

After major chunks and final source changes:

- Web `npm run build`: passed (existing large-bundle warning remains).
- Web `node --test tests/*.test.mjs`: **107/107 passed**.
- API entire suite in existing Node 20/ffmpeg Docker image with read-only source and isolated PostgreSQL fixtures: **83/83 passed**, no skipped tests.
- After the final bootstrap-idempotency/checkout configuration guards, affected API tests reran: **13/13 passed**.
- API/new-module/migration/worker syntax checks passed.
- `git diff --check` passed in both repos; existing LF/CRLF warnings remain.
- New AccountPlan and dawDuration code lint clean. Full web lint is still red: **302 errors / 30 warnings**, predominantly existing any/empty-catch/unused/hook issues across the repo. This is not claimed as a green full lint gate. Existing files were not broadly refactored to erase that debt.
- Read-only production checks: `https://api.ysong.ai/healthz` 200, `/healthz/db` 200, allowed www origin echoed, rejected test origin 403. No production provider generation/email/storage mutation was used as a test. Existing R2/ownership/range test coverage passed.

New tests exercise entitlement expiration/restrictions, immutable superadmin identity after email changes and repeat migration, quota bypass, 25 concurrent requests against 20 units, failure release idempotency, successful/disliked charging, 20-version allocation and unique project IDs, parent ownership, idempotency conflicts, bans/suspension, upload disablement, revocation, audited comp precedence, billing duplicates/staleness/rollback, official signature rejection/test-live separation, actual HTTP generation route quota/outcome/ownership, durable R2-boundary persistence, legacy frontend upload compatibility, dynamic E and shared Export ownership. Paid providers and billing network calls are mocked; real local PostgreSQL transactions are exercised.

## Remaining Priority 1 work and security/release concerns

- Complete durable server-owned **whole-session** orchestration: approved manifests, quantity UI 1–20, one unit per successful song version, measurable per-part/version progress, partial/retry handling, cancellation and restart recovery. The reservation/job schema is ready, but there is no restart-safe batch worker/public batch submission UI yet.
- Adopt the existing DAW/project identity in those jobs; current standalone render project UUIDs are allocation references, not automatically linked editable DAW projects. Do not create a competing project store.
- Wire server history/feedback into the existing Generation Library, import existing browser history carefully, and retain immutable prompt/lyrics/settings/model/version references. Existing Create Song local recovery still remains its active owner until orchestration is complete.
- Complete metering across non-music generation executors and related vocal/critique services. The opt-in gates are intentionally not a claim that all public paid endpoints are launch-ready.
- Add stale-job/orphaned-reservation evidence-based reconciliation. A crash after storage but before DB reconciliation can retain a reservation; never refund or rerun paid work blindly. Successful artifacts retain their version-derived keys for inspection.
- Finish content hide/remove/restore and moderation-review UI using existing World/rights owners. No visual nudity classifier or broad scanning was added, and metadata checks are not represented as visual safety verification.
- Add new/changed-content artwork policy handling, upload rights/legal/DMCA/repeat-infringer workflows and attorney-reviewed legal surfaces. Existing rights/fingerprint foundations remain, but they do not establish copyright ownership.
- Add full prompt/lyrics/blueprint/MIDI/master provenance hashing and distinctive long lyric collision evidence. Current request/audio hashes are integrity foundations only.
- Build actual Synthetic Cleanser → Humanizer → mix → independent QA/listening integration. No audio-quality claim was made without listening/measurement.
- Bridge signed packaging, billing sandbox end-to-end exercise, admin 2FA and session inventories remain follow-ups. Session revocation currently applies to routes using the existing shared JWT middleware; separate signed media links/realtime verification paths require a complete security audit before claiming universal revocation.
- Existing auth-api `.github/workflows/deploy.yml` can still deploy the retired VM on a main push. Do not push this repo until that workflow is deliberately migrated/reviewed. It was preserved, not triggered.
- Priority 2 rollout, mobile polish and ordinary backlog work were not started ahead of these unfinished Priority 1 requirements. Some required foundations (audit, controls, override expiry, billing modes) naturally also support Priority 2.

## Git status at handoff

Both repos remain dirty; no changes were staged, committed, pushed or deployed. Existing migration changes were preserved. `cloudflare/`, `src/storage/` and the earlier migration tests/docs were already untracked before this pass.

Auth API tracked modified files: `.dockerignore`, `.env.example`, `.gitignore`, `package-lock.json`, `package.json`, `src/index.js`, `src/promotion/routes.mjs`. Untracked paths: `cloudflare/`, `docs/cloudflare-production-migration.md`, this handoff, `scripts/migrate-saas.mjs`, `src/saas/`, `src/storage/`, `test/cloudflare_music.test.mjs`, `test/saas.test.mjs`, `test/storage_routes.test.mjs`.

Web tracked modified files: `.env.example`, `src/components/WorldPlayer.tsx`, `src/lib/devCrossWindowSync.ts`, `src/lib/musicGeneration.ts`, `src/tabs/CreateSong.tsx`, `src/tabs/DAW.tsx`, `src/tabs/SettingsPane.tsx`. Untracked: `src/components/AccountPlan.tsx`, `src/lib/dawDuration.ts`, `tests/createSongGeneration.test.mjs`, `tests/dawDuration.test.mjs`, `tests/deviceSyncFetch.test.mjs`, `tests/generatedDawImport.test.mjs`, `tests/musicGenerationPersistence.test.mjs`.

Bridge remained at its pre-existing `M .gitignore` and `?? instruments/` state; no edits were made there.

## Next verification

Start with the whole-session executor and project-linkage gap, then exercise a sandbox account end-to-end: approved MIDI+vocal manifest → queued server job → leave/return → saved partial/complete assets → existing Generation Library → independent DAW project → dynamic E → existing Export. Verify twenty intentional versions consume twenty successful units, not twenty units per stem; verify crash/restart evidence and cancellation before considering public billing. Keep SaaS disabled and retain the existing production/Git/Autopilot gates until that pass is complete.

## Priority 1 Pass 2 — local implementation and validation

### Outcome and enablement decision

The Create Song → durable batch/version → history → editable project → existing DAW path is now connected locally behind `SAAS_ENABLED`. **Keep SaaS disabled. It is not yet safe to enable publicly.** The existing local environment was checked without displaying credentials and remains disabled; `.env.example` retains `SAAS_ENABLED=0`. No production migration, deployment, commit, push, paid AI/music request, billing call, nameserver change or Autopilot launch occurred. No Priority 2 work was started.

Pass 1 entitlements, quota periods, billing boundaries, immutable superadmin identity, administration, durable audio, dynamic E and Export remain intact. Existing Cloudflare/R2/Vercel/Neon/Resend/Bridge changes were preserved.

### Whole-session execution and quota

- `POST /api/generations/batches` accepts an explicitly approved bounded multitrack plan, original prompt/lyrics, quantity 1–20, persistent request key and optional owned parent generation ID. It validates timing, IDs, MIDI events, duration and payload budgets. Client-supplied output keys cannot establish successful generation.
- Existing atomic reservation creates one batch and independent stable child/version/project identities. Replaying the same request returns those identities; altered content under the same key is rejected. Parent ownership and immutable lineage root/depth are retained.
- The API process runs a provider-neutral durable executor. PostgreSQL session advisory locks prevent two API processes executing the same child; state is re-read after claiming. An atomic queued→planning update races safely with queued cancellation. Execution begins only while SaaS is enabled.
- Each child independently persists parts and transitions through planning/generating/processing/finalizing and terminal ready/partially_ready/failed/cancelled states. Queued untouched parts can resume after process restart. The worker does not depend on any page staying open.
- Editable MIDI patterns are expanded into structured notes with stable clip/track IDs and retained VST identity. Neural audio uses the existing audio.cpp, Cloudflare Music 2.6 or legacy HTTP adapter, then the existing owned storage helper with a version/part-derived object key. No provider SDK or replacement audio endpoint was added.
- One usable saved version consumes one quota unit regardless of stem count. Failed pre-submission work releases its reservation. Partial successes retain their MIDI/audio and consume once. Safe component retry keeps ready parts and does not charge an already consumed version again. A wholly failed retry re-reserves atomically within the original still-open quota period; after period rollover a fresh variation is required. Feedback/history removal do not refund consumed work.
- Provider request/settings, seed, model/config version, signed-download result's durable object key, content type, bytes and SHA-256 audio hash are retained. Cloudflare tokens remain server-only and are neither returned nor logged by this executor.

### Recovery boundaries

- A persisted submitted/processing part found after restart becomes `ambiguous`. Provider exceptions and uncertain storage outcomes also require review. These renders are never silently retried or refunded, including when no usable part was recovered. Good parts remain available; a partial saved project remains chargeable once.
- `POST /api/generations/:id/retry` admits only confirmed pre-submission failed parts, checks account entitlement, preserves existing parts and reserves quota only when needed. Concurrent duplicate retries cannot execute/charge twice.
- `POST /api/generations/:id/retry-finalization` retries saving durable parts without a provider call. Project-save failure retains parts and reservation instead of refunding a potentially usable result. This also supports a save failure during a previously consumed partial version's safe retry.
- Terminal state, execution saved/progress state and quota reconciliation are written together in the reconciliation transaction. A process interruption after project storage but before reconciliation resumes finalization against the same project identity.
- Account/provider controls are checked before each untouched part. Revocation checks use the job's creation time for background execution, and entitlements/retry routes retain authenticated JWT issue time so newly authenticated sessions after revocation can work.
- Cancellation remains intentionally queued-only. Active provider calls are not presented as cancellable/refundable. No destructive orphan cleanup was added.

### Existing project and history ownership

No new project table or project store was created. Finalization locks the existing user's `user_client_state` row and writes string values under `ysong:daw:<projectId>`, `ysong:projectName:<projectId>` and the existing `ysong:projects:v1` catalog. Existing unrelated state is retained. Safe retry adds newly available clips/assets by stable ID; existing edited tracks/clips are not replaced.

The existing `/api/generations/history` response now naturally includes persisted `execution` alongside its source, batch quantity, provider/model/version, parent, feedback, project reference and timestamps. `GenerationJobs` is used in Create Song and the existing Library, polls server state and merges records into the existing `generationLibrary` catalog. Browser-owned earlier generations/folders are preserved. History supplies private thumbs up/down, Reuse Prompt, immutable Create Variation, queued cancellation, eligible recovery, detailed settings/provenance and Open Project / DAW actions.

`GET /api/generations/:id/project` reads only an owned saved project. Hydration retains its server project ID and gives existing local edits precedence. Both history surfaces feed the existing `localProjectOpenRequest` flow, retaining its unsaved-project switch confirmation. The SaaS path does not feed the legacy importer that allocates a fresh random project each time. No direct modifications to DAW or its export logic were needed in Pass 2.

### Frontend behavior and real progress

Create Song shows Quantity / Versions when the server reports SaaS enabled, plus reserve/consumption impact. It reads current server quota before submission; the server remains authoritative. Submission stores the complete request and key under an account-scoped browser key before HTTP. An interrupted HTTP response can be retried with the exact same request. Page navigation after acceptance no longer owns rendering.

Generation History shows child index/quantity, batch work-unit counts, actual part completion, current operation, persisted outcomes and precise recovery diagnostics. Each ready part is one completed work unit; successful project finalization is the last unit. No elapsed-time interpolation is used. A complete project reaches 100%; partial projects remain below 100% while still available to open. AccountPlan shows used/reserved/remaining/allowance, reset date and quantity impact; configured upgrade links remain the existing optional billing path.

### Exact Pass 2 changed files

Auth API:

- `src/index.js` — executor registration/startup, existing provider/storage adapters, JWT issue-time propagation.
- `src/saas/schema.sql` — additive `execution jsonb` column on existing generation versions.
- `src/saas/service.mjs` — atomically save terminal execution with reconciliation; consumed partial retry updates without charging again; authenticated summary issue time.
- `src/saas/routes.mjs` — propagate authenticated issue time to entitlement summary.
- `src/saas/jobs.mjs` — new whole-session validation/executor/project persistence/recovery routes.
- `test/session_jobs.test.mjs` — new mocked-provider/local PostgreSQL lifecycle and boundary tests.
- `docs/saas-productization-handoff.md` — this preserved Pass 1 report plus Pass 2 addendum.

Web:

- `src/tabs/CreateSong.tsx` — gated quantity/submission/reuse/variation and persistent request recovery.
- `src/tabs/Library.tsx` — server history/status and stable project hydration/opening.
- `src/components/AccountPlan.tsx` — used/remaining/reserved and quantity impact.
- `src/components/GenerationJobs.tsx` — new reusable server job/history UI within existing tabs.
- `src/lib/sessionJobs.ts` — server history→existing catalog, measured progress, non-destructive project hydration.
- `tests/createSongGeneration.test.mjs` — preserve legacy fixture, test server submission/replay/no frontend paid loop.
- `tests/sessionJobs.test.mjs` — new actual module tests for progress/history/disabled mode/project identity/edit preservation.

No dependency, provider configuration, `.env`, Bridge source, existing DAW source or unrelated product file was changed in Pass 2. `D:\YSong\.logs\saas-pass2-lint.json` is a local ignored validation report, not a source change.

### Migration and operations

The existing explicit `scripts/migrate-saas.mjs --apply` migration reads the updated additive schema. It must be reviewed and deliberately applied before enabling this path; it was exercised only against isolated local PostgreSQL fixtures, including repeat migration. `user_client_state` remains the already existing application table. No production schema write was performed and no launch flag was changed.

The runner is attached to the existing long-lived Auth API process, uses PostgreSQL locks and the existing music timeout policy. It requires that process to be alive to progress; restarting resumes safe work. It is not a claim of a distributed managed queue, Cloudflare Worker background scheduler or paid-render idempotency support at the upstream provider.

### Final validation

- Focused generation/quota integration tests first: 21/21 initially; expanded session-job integration suite subsequently passed 13/13 before the final session-revocation coverage was added.
- Final full API suite: **98/98 passed**, zero skipped, in the existing Node 20/ffmpeg image with a read-only source mount and dedicated local PostgreSQL. All AI/music adapters are mocked. Tests include four-version execution, 20-version allocation from Pass 1, concurrent quota overspend prevention, concurrent worker locking, replay, source validation, genuine failure release, safe retry charging, interrupted-call recovery, partial outcomes, mixed batches, owner-only history/project access, immutable variation references, project-save recovery, stable MIDI/VST/E data, preserved edits, cancellation, post-revocation new sessions and recovery from a temporary database connection outage. The test container was stopped after validation; its fixture data was preserved.
- Full web suite: **113/113 passed**, zero skipped. Final affected Create Song/session job tests additionally passed **9/9** after lineage updates. Existing DAW/import/Export tests remained green.
- Final `npm run build` including `tsc -b`: passed. The existing Vite large-chunk warning remains.
- Auth API index/jobs/service/routes syntax checks passed.
- New GenerationJobs/sessionJobs and changed AccountPlan/Library surfaces lint clean. Focused lint including CreateSong remains red with **10 existing errors**, chiefly old explicit-any/empty-catch/unused code; none was newly introduced by Pass 2. Prior full-repository lint was **302 errors / 30 warnings** and was not broadly cleaned or represented as green.
- Both repositories' `git diff --check` passed with existing LF/CRLF warnings only.
- No production, paid music, email delivery, real checkout or listening test was performed in Pass 2. Pass 1's production health/Neon/CORS results remain historical evidence, not a new release validation.

### Remaining Priority 1 / human launch gates

**Not ready for public enablement.** The local generation/project/history path is substantially coherent, but release still needs:

- Reviewed production additive migration, deployment validation and authorized sandbox-account walkthrough of approved MIDI/vocal plan → leave/return → partial/complete project → DAW/Export. Paid production quality/listening is untested in this pass; prompt-based isolated vocals are not proof of actual stem separation.
- Evidence-based operator resolution for ambiguous provider/storage outcomes. The conservative review state is implemented, but no automatic refund/re-render or comprehensive operator reconciliation UI is claimed. Crash after object storage but before its DB acknowledgement can require inspecting the deterministic object key. Missing part retries added server-side are hydrated into a new browser/project view; an already open/edited local DAW project is deliberately not overwritten by polling.
- Normalized metering across other existing paid assistant/artwork/vocal/critique endpoints and any direct standalone render uses; standalone music retains its existing one-render contract. Complete explicit provider idempotency before relaxing the uncertain-response restrictions.
- History currently presents the existing latest-200 server records; large-history pagination and cross-device edit conflict resolution remain follow-ups. Existing local history removal does not delete server audit provenance or refund credits.
- Finish the previously documented Priority 1 moderation/legal/rights, artwork enforcement/provenance, quality processing/QA, session security audit and Bridge packaging requirements in their own authorized passes. These were not expanded in this generation-focused pass.
- Account owner must configure actual plan capabilities/allowances, Stripe products/prices matching test/live mode, secret/webhook dashboard setup and verified checkout/subscription/cancellation webhook sandbox behavior. No prices/quotas were invented and no billing credentials were printed.
- Preserve the obsolete VM workflow safety gate; no main push until that workflow is deliberately reviewed/migrated. The original production-validation and single-instance Autopilot gates still apply; Autopilot was not started.

### Git status after Pass 2

Everything remains unstaged/uncommitted. Auth API tracked modifications: `.dockerignore`, `.env.example`, `.gitignore`, `package-lock.json`, `package.json`, `src/index.js`, `src/promotion/routes.mjs`. Untracked paths: `cloudflare/`, `docs/cloudflare-production-migration.md`, `docs/saas-productization-handoff.md`, `scripts/`, `src/saas/`, `src/storage/`, `test/cloudflare_music.test.mjs`, `test/saas.test.mjs`, `test/session_jobs.test.mjs`, `test/storage_routes.test.mjs`. Pre-existing migration/Pass 1 changes were preserved.

Web tracked modifications: `.env.example`, `src/components/WorldPlayer.tsx`, `src/lib/devCrossWindowSync.ts`, `src/lib/musicGeneration.ts`, `src/tabs/CreateSong.tsx`, `src/tabs/DAW.tsx`, `src/tabs/Library.tsx`, `src/tabs/SettingsPane.tsx`. Untracked: `src/components/AccountPlan.tsx`, `src/components/GenerationJobs.tsx`, `src/lib/dawDuration.ts`, `src/lib/sessionJobs.ts`, `tests/createSongGeneration.test.mjs`, `tests/dawDuration.test.mjs`, `tests/deviceSyncFetch.test.mjs`, `tests/generatedDawImport.test.mjs`, `tests/musicGenerationPersistence.test.mjs`, `tests/sessionJobs.test.mjs`.

Bridge remains its prior `M .gitignore` and `?? instruments/` state; no Pass 2 edits there. **Nothing was staged, committed, pushed or deployed.**

## Priority 1 Pass 3 — launch gates, billing, metering and governance (2026-10-02)

### Outcome and readiness

**B — READY FOR BILLING CONFIGURATION. Not ready for controlled deployment or SaaS enablement.** The local implementation and automated validation are complete for this pass; production configuration, legal publication and manual release validation remain gated below. `SAAS_ENABLED` remains off. The infrastructure migration remains complete and was not repeated. Vercel, Neon, Resend, Cloudflare/R2 and the existing generation/Bridge architecture remain intact. Pass 1 and Pass 2 summaries above remain historical evidence.

This pass added a configured price catalog, guarded Stripe checkout/portal, a shared assistant cost boundary, audited operator render reconciliation, new-content moderation and existing ContentRightsGate enforcement, versioned legal acceptance and takedown case plumbing. It did not claim automated visual classification, legal ownership proof, guaranteed vocal isolation, statutory notice completeness or completed legal review.

### Exact files changed in Pass 3

Paths in this subsection are relative to their named canonical repository. Earlier dirty work in other files was preserved.

Auth API (`D:\YSong\ysong-auth-api`), 16 files:

- `.env.example` — operator configuration comments only; existing server-only credentials remain blank examples.
- `.github/workflows/deploy.yml` — neutralized retired VM deployment locally.
- `src/index.js` — middleware wiring, paid-helper checks, upload/public-media governance, artifact inspection and standalone render uncertainty tracking.
- `src/saas/schema.sql` — additive catalog, usage, policy, moderation, case and checkout configuration/state tables.
- `src/saas/plans.mjs` — new sanitized canonical public catalog representation.
- `src/saas/routes.mjs` — catalog/account/portal/checkout guards and admin usage inspection.
- `src/saas/metering.mjs` — new shared paid assistant boundary and request ledger.
- `src/saas/governance.mjs` — new moderation, rights, legal acceptance and takedown case routes.
- `src/saas/jobs.mjs` — operator uncertainty listing and evidence-based resolution.
- `scripts/saas-preflight.mjs` — new read-only launch checklist.
- `docs/saas-policies-draft.md` — six unpublished policy review worksheets and takedown operational requirements, marked ATTORNEY REVIEW REQUIRED.
- `docs/saas-productization-handoff.md` — this preserved historical handoff plus Pass 3.
- `test/saas_launch.test.mjs` — new mocked launch-boundary tests with isolated real PostgreSQL.
- `test/saas.test.mjs` — standalone uncertainty/reservation assertions.
- `test/cloudflare_music.test.mjs` — existing persistence harness governance dependency.
- `test/storage_routes.test.mjs` — existing storage harness governance dependencies and disabled-SaaS behavior.

Web (`D:\YSong\ysong-web\ysong`), 9 files:

- `src/App.tsx` — public `/pricing` route.
- `src/lib/authApi.ts` — request idempotency headers, preserving explicit request identities.
- `src/components/AccountPlan.tsx` — existing account surface integrations, stable checkout identity and selected-account usage inspection.
- `src/components/BillingAccount.tsx` — new server-confirmed billing status, period/cancellation and Stripe portal access.
- `src/components/PolicyAcceptance.tsx` — new current-version acceptance and timestamps.
- `src/components/RightsAndCases.tsx` — new explicit rights attestation and case/counter-notice forms.
- `src/components/GovernanceAdmin.tsx` — new role-guarded moderation, render/case decisions and audit inspection.
- `src/pages/Pricing.tsx` — new catalog-backed prices, configured capabilities/allowances and disabled unavailable plans.
- `tests/saasLaunch.test.mjs` — new executable component tests for prices, interrupted checkout identity, redirect behavior and policy acceptance.

No Bridge files were edited in this pass. No migrations, World/DAW layouts, Ads, ordinary backlog, provider architecture or unrelated legacy lint were refactored.

### Exact additive migration

The existing explicit `scripts/migrate-saas.mjs` still owns application of `src/saas/schema.sql`. There is no startup SaaS migration and no new production database was created. The schema was applied twice in isolated fixture schemas to verify replay. **It was not applied to production.**

- `ysong_plans`: added `monthly_price_cents`, `currency`, `billing_interval`, `storage_quota_bytes`, `available`, `public_visible`, `upgrade_order`, `usage_limits`.
- Seed intended USD monthly price cents only where the field is unset: Free 0, Basic 999, Pro 1999, Premium 2999. Existing operator prices survive migration replay. Generation/storage/assistant quotas and provider price IDs were not invented. Availability defaults false.
- `ysong_usage_events`: server user/request identity, request hash, capability, provider/model, unit count, admin exemption, outcome, optional reported cost, timestamps; unique user/request key.
- `ysong_policy_versions`, `ysong_policy_acceptances`: immutable version identity, active/approved/required configuration, exact version plus user/timestamp acceptance. Six review-draft records are inactive and unapproved.
- `ysong_content_reviews`: owned object key, content hash, review state/evidence, existing rights record.
- `ysong_takedown_cases`: claim/contact, claimant/object identity, state, pending notification, counter-notice and decision reason.
- `ysong_checkout_attempts`: per-account pending checkout lock, request identity, configured plan, expiration and server Stripe session result.

Existing account access, roles, quota periods, batch/version lineage, billing events, admin audit, client-state projects and Pass 2 execution JSON remain canonical.

### API and billing architecture

New endpoints:

- `GET /api/billing/catalog` (sanitized public configuration), `GET /api/billing/account`, `POST /api/billing/portal`.
- `GET /api/admin/accounts/:id/usage` (role-gated quota periods and latest 100 cost events).
- `GET /api/admin/generations/uncertain`, `POST /api/admin/generations/:id/parts/:part/resolve`.
- `GET /api/account/policies`, `POST /api/account/policies/accept`.
- `POST /api/content/rights`, `POST /api/content/rights/attest`.
- `GET /api/admin/content`, `POST /api/admin/content/review`.
- `POST /api/takedowns`, `GET /api/admin/takedowns`, `POST /api/admin/takedowns/:id/decision`, `POST /api/takedowns/:id/counter-notice`.

Existing checkout checks authenticated server entitlement, actual configured price, matching Stripe mode/active status/USD cents/monthly interval, required current approved billing/terms/privacy acceptance, existing subscription and per-account pending checkout identity. Uncertain checkout creation can be replayed using the same request key and Stripe idempotency key. Different pending requests conflict; they do not create simultaneous subscriptions. An expired attempt can be replaced; abandoning the browser does not instantly expire a pending Stripe session.

Official signed subscription webhooks remain authoritative and reject invalid signatures, test/live mismatch, stale events and replay. Subscription state, period, cancellation and configured price determine normal entitlements. Billing never overwrites immutable superadmin identity or manual overrides. Pending/incomplete, active/trialing, past-due/unpaid and canceled/deleted states retain the existing server lifecycle rules. Return URLs never grant access. The success return displays pending confirmation until server state changes.

Customer portal sessions use the linked server-side Stripe customer and configured return URL. Actual upgrade/downgrade, payment methods, cancellation and eligible resume behavior are controlled by the owner's default Stripe portal configuration. Checkout uses Stripe-hosted dynamic payment methods; Link availability must be configured/verified in Stripe rather than represented as a separate client access grant. Official references: [portal sessions](https://docs.stripe.com/api/customer_portal/sessions/create) and [portal configuration](https://docs.stripe.com/api/customer_portal/configurations/create).

### Cost boundary and uncertainty behavior

| Existing operation | SaaS-on classification and owner |
| --- | --- |
| `/api/music/generate` | Existing generation quota/version boundary; quantity one; binary audio contract preserved |
| `/api/generations/batches` | Existing atomic batch reservation and durable Pass 2 executor; one credit per version |
| `/chat`, room `/ai/respond`, `/api/critique/ai-summary` | Shared authenticated assistant ledger; explicitly configured monthly request units; server capability/provider checks and idempotency |
| Artwork `/api/artwork/generate`, composer, sound-designer and stem-composer POST executors | Unavailable for normal SaaS users until their execution contracts are integrated; superadmin calls are recorded as exempt, with provider controls and helper assertions |
| Status, metadata/search, library/World reads, uploads, existing deterministic DSP/vocal-to-MIDI, mixer processing, browser MIDI/VST and Bridge operations | No additional AI charge; existing auth/access/file ownership still applies |
| Future unregistered OpenAI/image helper caller | Fails closed under SaaS because no paid boundary context exists |

The assistant ledger records server user ID, provider/model, stable request key/hash, units, outcome and exemption. Reported monetary cost stays null when not supplied. Request units are not fabricated token usage or dollar estimates. Concurrent quota checks serialize by account. Duplicate/uncertain submissions are not blindly retried. HTTP failures/aborted responses remain uncertain; an interrupted database acknowledgement can leave a submitted row for operator review. Deterministic operations and file/VST activity are not assigned AI credits.

Session generation uncertainty persists in part execution state. Operator success resolution accepts only the exact deterministic, owned generation object key, materializes the existing artifact server-side and verifies nonempty bytes/hash before finalization. Failure resolution requires a reason and provider/support evidence reference. Role checks and immutable audit records apply; duplicate resolution is idempotent and conflicting decisions are rejected. Successful/usable work consumes once, evidenced failure releases once, uncertainty retains reservation, and the operator action makes no new paid render. Cloudflare's current synchronous adapter supplies no job-status lookup contract; none was fabricated.

Standalone music failures after submission now persist ambiguous audio execution and retain the reserved credit; confirmed success persists the owned artifact and consumed result. A process crash during a standalone submission can leave `generating`/`submitted` without automatic conversion to an ambiguous terminal state. **That stranded case still requires a reviewed operator repair after proving the old executor is stopped; do not retry/refund merely based on elapsed time.** This is a controlled-enable blocker, not claimed as automated recovery. Session-worker crash recovery is covered by existing advisory locking and tests.

### Moderation, rights and legal operations

Cheap MIME/magic-byte inspection puts new/changed image content into `needs_review`; no paid classifier runs. Unchanged bytes preserve the review and rights record, while changed bytes reset both. States include clear, needs_review, restricted, hidden, removed and restored. Admins record reasons and can approve existing rights evidence for reviewed uses. Hiding/removal also hides affected World listings; restoration touches only previously affected hidden listings and respects other blocked audio/artwork. Files/R2 objects are preserved. Public media checks both audio and cover rights/moderation and uses private/no-store caching when enabled. Existing cached public delivery needs a reviewed purge/revocation walkthrough before enablement.

The explicit artwork policy allows cleavage, swimwear, lingerie, shirtless people and non-explicit partial nudity; it blocks visible nipples/areola, genitalia, exposed pubic hair and explicit sexual content. This is a human review queue, not proof that pixels were classified.

Rights attestation uses server user/time/current approved upload policy version and the existing ContentRightsGate evidence contract. Existing source/fingerprint comparisons remain available; no duplicate ownership engine or new paid scanning was introduced. Client attestations and hashes alone cannot clear public use or prove ownership. New manual approval is required after changed evidence/content. Existing unpublished legacy objects need reviewed evidence/backfill before public use with SaaS enabled.

Takedown cases retain claim/contact, owner/claimant, counter-notice, review/removal/restoration decisions, prior-removal counts and audit. Admin account actions provide recorded repeat-infringer escalation; counts do not automatically ban users. **Notices remain pending manual delivery.** No email was sent or claimed delivered. Authenticated intake is not a complete public designated-agent/legally sufficient notice process. Counsel/owner must finalize the public agent contact, notice/counter-notice requirements, statutory timing, delivery records, litigation holds and repeat-infringer process before launch. See the unpublished policy worksheet and [Copyright Office section 512 guidance](https://www.copyright.gov/512/index.html).

Six policy identities cover terms, privacy, upload rights, billing, generated outputs and Bridge licensing. Current approved versions and acceptance timestamps appear in Settings/account. Stale version acceptance does not authorize a new version; explicit reacceptance is supported. Costly requests and uploads/publication fail closed without approved required policies and current acceptance; checkout separately requires approved terms/privacy/billing before Stripe calls. Drafts remain **ATTORNEY REVIEW REQUIRED**, inactive and unapproved; existing website legal pages are not silently promoted to reviewed SaaS agreements.

### Final validation

- Focused API launch + SaaS + session-job suites: **39/39 passed**, zero skipped, real dedicated loopback PostgreSQL and mocked paid providers.
- Final complete API suite: **111/111 passed**, zero skipped, existing Node 20/ffmpeg image, read-only repository mount and dedicated PostgreSQL fixture. This includes Cloudflare binary audio/status, storage ownership/ranges, billing/webhook/quota/admin tests and generation persistence/marker tests; no paid provider was called.
- New web launch component suite: **4/4 passed**. Full web suite: **117/117 passed**, zero skipped. The actual command is `node --test tests/*.test.mjs`; this repository has no `npm test` script. An initial `npm test` attempt only reported that missing script.
- `npm run build` passed, including `tsc -b`; 304 modules built. Existing Vite large-chunk warning remains.
- Focused ESLint passed for AccountPlan, BillingAccount, PolicyAcceptance, RightsAndCases, GovernanceAdmin and Pricing. No full legacy lint cleanup: historical full lint **302 errors / 30 warnings** and CreateSong's **10 existing errors** remain as documented above, not newly rerun or represented as green.
- Syntax checks passed for API index, routes, jobs, governance, metering and preflight. Both affected repositories' `git diff --check` passed; only existing LF/CRLF warnings were emitted.
- Read-only preflight `node scripts/saas-preflight.mjs --remote` returned exit **1 intentionally**, because launch configuration/manual gates are incomplete. Production `/healthz`, `/healthz/db` and allowed `https://www.ysong.ai` CORS passed. SaaS-off, Resend credential/sender presence and local retired-workflow audit passed. SaaS tables, plan allowances, price mappings, stored launch-role validation, assistant limits and approved policies were NOT CONFIGURED in the target database. Stripe live mode/key and webhook were NOT CONFIGURED. Dashboard, R2/public delivery/cache, frontend/account/pricing, billing sandbox, authenticated admin/audit, uncertain-render walkthrough and repository/release review remain MANUAL ACTION REQUIRED. Resend presence is not a new delivery test. The final script also reports provider configuration presence without making music calls and classifies any explicit FAIL as A, rather than claiming readiness.
- No new production signup/login, live checkout, listening, native Bridge, paid AI, email-delivery, deployment or public-policy approval test was claimed. Earlier migration evidence remains preserved.

### Production configuration and account-owner actions

Keep `SAAS_ENABLED=0`. Existing server-only configuration remains: `DATABASE_URL`/existing PG SSL settings, production CORS/auth/session secrets, R2 endpoint/bucket/server credentials, Cloudflare account ID/AI token/music model, existing provider credentials/controls, Resend key/sender and frontend API origin. Do not replace Neon/Vercel/Resend or change nameservers.

Billing needs server-only `BILLING_MODE` (`test` for sandbox; separately reviewed `live` for eventual production), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `BILLING_RETURN_URL`. No provider secret is a Vite variable. Actual generation allowances, assistant monthly request limits, capabilities, storage quotas, availability and Stripe test/live price references belong in `ysong_plans`; no new env-based entitlement or invented storage limit was added.

Owner actions before a controlled release:

1. Review/apply the additive SaaS migration to the intended database in a separately authorized release; verify exactly one immutable active superadmin and normal-user restrictions.
2. Deliberately configure all four plans' actual capabilities/allowances and available status. Confirm 999/1999/2999-cent USD monthly Stripe prices and store the exact matching test/live references; do not copy test IDs into live mode.
3. Configure Stripe products, hosted Checkout/eligible Link methods, customer portal product switching/downgrade/cancellation/resume/payment management and signed `/api/billing/webhook` subscription events. Run owner-authorized sandbox creation, incomplete/payment-failure, active/trialing, renewal, cancellation, resume, upgrade/downgrade, duplicate/stale webhook and redirect walkthroughs. Keep live charges off during validation.
4. Obtain attorney-approved policy text, immutable version URLs and public legal/agent contact. Publish approved required versions deliberately, test reacceptance and record a real notification/appeal/counter-notice workflow with legal deadlines. Pending case notifications and policy drafts are release blockers.
5. Run authenticated normal/admin/superadmin UI and cost-boundary walkthroughs, generation leave/return/import/export and reconciliation with controlled evidence. Verify stranded standalone recovery procedure, artifact format/playability, isolated-vocal quality limitations and legacy-public-object backfill/cache handling. Do not blindly retry paid work.
6. Review repository secrets and all unstaged changes, then perform the original production/release validation gates. No commit/push/deploy or Autopilot sequence is authorized by a passing local test alone.

### GitHub workflow and Git status

The only auth API GitHub workflow is `.github/workflows/deploy.yml`. It previously deployed a retired VM from pushes/manual dispatch using SSH/rsync/service restart. The **local** replacement has no push trigger, SSH secrets, remote upload or restart: manual dispatch only prints that VM deployment is retired. Nothing was pushed, so GitHub's remote workflow has not been updated. A future reviewed push containing this replacement cannot trigger the old VM deployment; do not push a version still containing the old workflow. No separate automatic Cloudflare release workflow was introduced.

Final auth API tracked modifications: `.dockerignore`, `.env.example`, `.github/workflows/deploy.yml`, `.gitignore`, `package-lock.json`, `package.json`, `src/index.js`, `src/promotion/routes.mjs`. Untracked: `cloudflare/`, `docs/cloudflare-production-migration.md`, `docs/saas-policies-draft.md`, `docs/saas-productization-handoff.md`, `scripts/`, `src/saas/`, `src/storage/`, `test/cloudflare_music.test.mjs`, `test/saas.test.mjs`, `test/saas_launch.test.mjs`, `test/session_jobs.test.mjs`, `test/storage_routes.test.mjs`.

Final web tracked modifications: `.env.example`, `src/App.tsx`, `src/components/WorldPlayer.tsx`, `src/lib/authApi.ts`, `src/lib/devCrossWindowSync.ts`, `src/lib/musicGeneration.ts`, `src/tabs/CreateSong.tsx`, `src/tabs/DAW.tsx`, `src/tabs/Library.tsx`, `src/tabs/SettingsPane.tsx`. Untracked: `src/components/AccountPlan.tsx`, `src/components/BillingAccount.tsx`, `src/components/GenerationJobs.tsx`, `src/components/GovernanceAdmin.tsx`, `src/components/PolicyAcceptance.tsx`, `src/components/RightsAndCases.tsx`, `src/lib/dawDuration.ts`, `src/lib/sessionJobs.ts`, `src/pages/Pricing.tsx`, `tests/createSongGeneration.test.mjs`, `tests/dawDuration.test.mjs`, `tests/deviceSyncFetch.test.mjs`, `tests/generatedDawImport.test.mjs`, `tests/musicGenerationPersistence.test.mjs`, `tests/saasLaunch.test.mjs`, `tests/sessionJobs.test.mjs`.

Bridge (`D:\YSong\ysong-bridge`) remains its prior `M .gitignore`, `?? instruments/` state, with no Pass 3 changes. Build outputs remain ignored. Validation fixture schemas/data are preserved; the local validation container is stopped after testing.

**Nothing was staged, committed, pushed or deployed. No paid AI/music calls or live charges were made. No production schema/policy/plan/flag was changed. No data/R2 objects were deleted. SaaS remains disabled. Priority 2 and Autopilot were not started. Stop after this handoff.**

## Post-Pass-3 launch preparation — 2026-10-02

Completed the authorized local launch-preparation pass. Readiness remains **B**, not C/D. The separate queued Band Creation request follows this pass; it does not authorize production enablement.

The exact production configuration matrix, owner actions, future release order, recovery procedures and rollback gates are in [saas-production-launch.md](saas-production-launch.md). The intentionally incomplete [configuration example](saas-launch-config.example.json) supplies no invented quota or Stripe reference. Configuration validation defaults to structure-only; future `--apply` requires SaaS off, explicit target host, actual verified Stripe prices/products, immutable stored superadmin and atomic audited configuration. Reviewed policy references/versions are required; drafts cannot be accepted by toggling a boolean.

Closed the previously documented stranded-submission gap with reasoned admin recovery and executor locking. Added guarded queue cancellation, reserved-ledger recount, stored-artifact-only project finalization, verified billing-profile linking, current-subscription reconciliation and verified failed-webhook replay. Recovery never implicitly submits a paid replacement. Existing inbox notifications cover critical generation/billing/governance transitions; formal notice delivery remains a human procedure with explicit receipt/failure evidence. The schema remains additive and production-unapplied. Signed billing ingestion can be separately enabled while SaaS stays off; no flag was changed here.

Files changed by this preparation (in addition to preserved earlier work): API `.env.example`, `cloudflare/worker.js`, `cloudflare/deploy.mjs`, `src/index.js`, `src/saas/schema.sql`, `src/saas/service.mjs`, `src/saas/billing.mjs`, `src/saas/routes.mjs`, `src/saas/governance.mjs`, `src/saas/jobs.mjs`, `src/saas/notifications.mjs`, `src/saas/policies.mjs`, `src/saas/recovery.mjs`, `src/saas/configuration.mjs`, `src/saas/preflight.mjs`, `scripts/configure-saas.mjs`, `scripts/saas-preflight.mjs`, `test/saas.test.mjs`, `test/saas_launch.test.mjs`, `test/saas_readiness.test.mjs`, `docs/saas-launch-config.example.json`, `docs/saas-production-launch.md` and this handoff. Web `src/components/AccountPlan.tsx`, `src/components/GovernanceAdmin.tsx`, `src/components/RecoveryAdmin.tsx`. The retired workflow was inspected and preserved, not modified again. Bridge unchanged.

Validation: complete API **126/126**, zero skipped, against preserved isolated local PostgreSQL with mocked Stripe/paid generators and read-only repository mount. Web **117/117**, zero skipped. TypeScript/production build pass (305 modules; existing Vite chunk-size warning). Focused AccountPlan/RecoveryAdmin/GovernanceAdmin ESLint passes. API/Worker/deploy/SaaS/script syntax checks and both repository diff checks pass (existing CRLF warnings only). Read-only preflight reports **B**, intentional exit 1: API/Neon/CORS/R2 metadata/frontend reachability pass; SaaS schema/configuration, live billing/portal/webhook/redirects and approved policies remain missing/manual. No unchanged blocker was repeatedly probed.

No production schema/configuration/flag was applied; no paid call, live charge, email, commit, push or deployment occurred. Existing dirty Git changes/untracked files and fixture data are preserved. Production bindings, dashboard behavior, legal approval/delivery, authenticated live gates, cache/backfill and final repository/release approval are still owner actions. No Priority 2 or Autopilot was started.

Cloudflare `npm run check` dry-run also passes with local Docker access; no deployment occurred. The first sandboxed attempt could not write Wrangler's user log or access Docker, then the approved dry-run succeeded. Existing dependency audit output reports 14 vulnerabilities (2 moderate, 11 high, 1 critical); no unrelated dependency upgrades were made in this pass.

## Queued Band Creation lifecycle request — completed after launch preparation

Implemented the separate explicitly authorized UX change locally after finishing the launch-preparation handoff. New Band saves open **Link your existing music** after normal identity metadata. The server suggests only the authenticated user's unlinked catalog releases with normalized matching artist-name metadata. Cards show artwork, title, current artist metadata, single/album and known publication date; no checkbox is selected automatically. Select All, individual selection, pagination, Back and Skip for now are available. A candidate-load outage cannot prevent creating the Band with Skip.

Confirmation first persists the existing account-owned artist/Band identity, then submits explicitly selected release IDs. The existing `artists.id` / `artist_id` is the stable Band ID; no duplicate `band_id` ownership system or schema migration was introduced. The server rechecks artist and release ownership, locks the artist/release/tracks, refuses conflicting existing links or inconsistent track ownership, and updates only the selected release/track `artist_id` fields. Each release is its own atomic transaction. A release failure rolls back that release, preserves the created Band and other successes, and is reported per card. Repeating the same selection is safe; competing links cannot overwrite an existing different Band link.

Release/track IDs, media keys, original display metadata, timestamps, plays, likes, comments, playlists, analytic records and URLs are preserved. Name normalization supplies suggestions only, never global linking or authorization. The current catalog has no delegated-control grant model; trusted `owner_user_id` is its control boundary. Saved/followed public releases and claimed rights alone cannot authorize attachment of another user's releases.

Saved Bands expose **Link Existing Releases**, which lists all owned unlinked releases, including older/skipped/differently named uploads, and permits retry. Upload Music already requires an account-owned artist/Band and publishes with its stable ID; its choices now refresh on Band creation/change while retaining a valid current selection. Thus legacy upload -> later Band, Band -> normal upload, and existing Band -> repair linking use the existing architecture. Browser-only raw files without server catalog metadata are not invented as releases or automatically published.

Exact files changed for this queued request:

- API `src/index.js` (register the narrow route module), `src/artists/releaseLinking.mjs`, `test/release_linking.test.mjs`, and this handoff.
- Web `src/lib/artistApi.ts`, `src/tabs/BandCreation.tsx`, `src/tabs/UploadMusic.tsx`, `src/components/LinkExistingReleases.tsx`, `tests/bandReleaseLinking.test.mjs`.

Final validation after Band changes: full API **133/133**, zero skipped (7 new Band tests, isolated preserved PostgreSQL; paid adapters mocked). Full web **122/122**, zero skipped (5 new creation/skip/partial/retry/upload-choice tests). TypeScript and production build pass, 306 modules; existing Vite chunk-size warning remains. Focused lint for new linking component/API helpers and launch components passes. BandCreation retains **5** existing lint errors and UploadMusic **2**; comparing current diagnostics with `HEAD` confirms zero added/changed lint diagnostics. API/index syntax and both repository diff checks pass, CRLF warnings only. Bridge remains its prior `.gitignore`/`instruments/` state with no changes. Validation fixture schemas/data are retained and the container is stopped after testing.

No production Band records were linked during preparation, no deployment or production schema/flag changes occurred, and no commit/push, paid generation, live charge, email or data/R2 deletion occurred. The new UX is local until a separately approved release. Production billing/legal/manual gates remain as listed above; readiness stays B and SaaS stays disabled. No Priority 2 or Autopilot was started.

## Uploader track-edit access across World and Library — 2026-10-02

Completed the next user-authorized local UX fix. World release shelves, individual song details and playlist rows now expose uploader-only edit ellipses, alongside the existing Trending/search/release track-row editor. My Library All Music, Saved Songs and Your Uploads lists expose the same uploader-only controls. Playlist ownership alone never grants track-edit permission. Editing no longer depends on Trending placement. Three-dot edit controls use server-reported track ownership; non-owner World rows retain ordinary save/radio actions under their separate general-actions icon. The existing authenticated API mutation still selects by both track ID and original uploader ID; no backend permission or schema change was made.

The existing metadata editor was shared between World and Library, preserving its fields and API contract. Menus use a portal so shelf/list overflow cannot clip them, and support keyboard Escape, touch/click and viewport positioning. Saved metadata updates World/Library through existing patch/refresh events. Editor instances are keyed by track ID; media, IDs and engagement records are untouched.

Exact files changed for this request: web `src/tabs/World.tsx`, `src/tabs/Library.tsx`, `src/components/OwnedTrackActions.tsx`, `src/components/WorldTrackEditor.tsx`, `tests/ownedTrackEditing.test.mjs`; API documentation `docs/saas-productization-handoff.md` only. Other local work was preserved.

Validation: **127/127 web tests**, zero skipped, including five owner/non-owner, metadata-save, shelf/detail, Library and playlist-ownership regressions. TypeScript/production build passes (308 modules, existing Vite chunk-size warning). New components and Library pass focused ESLint; World retains 13 existing errors / 3 warnings (HEAD had 14 / 3; moving the editor removed one legacy `any` error). `git diff --check` passes with existing CRLF warnings. API code was inspected for its existing uploader filter, not modified or newly exercised in production. No commit, push, deploy, paid call, live charge or production record edit occurred. These UI changes remain local until an approved release.

## Release metadata editing and Upload Music follow-up — 2026-10-02

Completed locally: the shared uploader-only Edit Track screen shows its current album/single cover, supports owned image replacement with preview and retry, and adds a calendar release date and optional Record Label (180 characters). Upload Music now has the same calendar and Record Label controls and publishes them through the existing API. Album date/label/cover are shared release metadata. Blank date/label on Upload Music omit those fields so adding a track cannot erase existing album metadata; editing permits explicit clearing. Historical release date stays separate from the original publication/upload timestamp.

Server validation rejects invalid calendar dates, excessive label values and unowned/non-image replacement covers. Track edits commit shared release metadata and track changes together; publishing also commits release metadata and its new track together, rolling back on failure. Replacement retry reuses its uploaded object. Artwork revision URLs and existing refresh events update sibling album covers and the player without replacing IDs, track titles, engagement records, media or URLs. Original artwork objects are preserved; existing public-media governance remains in force.

The existing World schema guard adds nullable release_date and record_label columns. This additive schema change has NOT been applied to production; no deployment/startup against production was performed.

Exact files changed for these metadata requests:
- API: src/index.js; new src/artists/releaseMetadata.mjs; new test/release_metadata.test.mjs; docs/saas-productization-handoff.md.
- Web: src/components/WorldTrackEditor.tsx; src/components/WorldPlayer.tsx; src/lib/worldApi.ts; src/tabs/World.tsx; src/tabs/Library.tsx; src/tabs/UploadMusic.tsx; tests/ownedTrackEditing.test.mjs; tests/bandReleaseLinking.test.mjs.

Final validation: API 141/141 and web 131/131, zero skipped; actual edit/publish routes exercised against preserved isolated PostgreSQL with storage and paid adapters mocked. Tests include single/album date and label round-trip, omitted album fields, invalid-date rejection, uploader ownership, replacement retry and atomic rollback. API syntax and both repository diff checks pass (existing CRLF warnings). TypeScript/production build result recorded below. New editor and Library focused lint pass; existing baseline lint remains World 13 errors/3 warnings, WorldPlayer 4 errors, worldApi 1 error, UploadMusic 2 errors; no new diagnostics introduced.

No production edit/schema/flag change, paid generation, live charge, commit, push or deployment occurred. Existing local work, original assets and isolated database fixtures are preserved. Production launch gates remain unchanged.

TypeScript and production build pass (308 modules; existing Vite chunk-size warning). The isolated validation container is stopped; fixture data is retained.
