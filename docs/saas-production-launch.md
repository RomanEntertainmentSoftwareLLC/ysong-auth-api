# SaaS production launch runbook — local preparation only

2026-10-02. Readiness **B: ready for billing configuration**. SaaS stays disabled. Nothing in this document authorizes applying a production migration, enabling billing, deploying, committing, pushing, charging a customer or calling a paid generator. Preserve the completed Cloudflare/R2/Neon/Vercel/Resend architecture and migration evidence.

## Configuration matrix

### Stripe test catalog bootstrap

Run `node scripts/bootstrap-stripe-test.mjs --check` (or `--dry-run`; check is the default).
Without credentials this prints the intended Basic $9.99, Pro $19.99, and Premium
$29.99 USD monthly catalog and reports `offline`; it does not claim Stripe was
verified. Free always has null product/price references and needs no subscription.
With `STRIPE_SECRET_KEY` supplied through the operator process environment, check
lists the complete Stripe catalog read-only and reports proposed creates or reuse.
The utility deliberately does not load `.env`. Never put keys in command arguments,
logs, configuration JSON, source control, or browser/Vite environment variables.
If set, `BILLING_MODE` must be `test`. Only `sk_test_` secret keys are accepted;
live, restricted, publishable, and unrecognized keys fail closed even in check mode.

The catalog command that mutates Stripe is:

```sh
node scripts/bootstrap-stripe-test.mjs --apply-test-mode
```

Use an isolated Stripe test account/environment. This explicit flag creates only
missing products/prices with `ysong_plan=basic|pro|premium` metadata. Repeating the
command reuses discovered resources; deterministic Stripe idempotency keys protect
retries and overlapping creates. Run one operator at a time. Stripe idempotency
retention is finite; durable rerun discovery relies on preserving metadata. The
utility refuses duplicate, archived, untagged attached, or incompatible prices
(including different amounts, currency, interval counts, or metered billing).
Resolve conflicts in the test dashboard before retrying; it never deletes or
silently replaces catalog resources. A partial failure may leave test resources;
rerun after resolving the failure to reuse them. Errors suppress provider details
to avoid exposing credentials, and return a nonzero exit status.

The JSON output contains only test catalog references and actions, not credentials.
Copy each `productId` and `priceId` into the matching plan in an operator copy of
`docs/saas-launch-config.example.json`, keeping `mode: "test"` and Free references
null. Do not copy the bootstrap-only `action` field. Complete the existing reviewed
quota, capability, identity, database, and policy values; then use
`node scripts/configure-saas.mjs --file <reviewed-file> --check` and the existing
reviewed `--apply` workflow against the intended test database. That configuration
boundary alone persists the references under `ysong_plans.billing_prices` and
`billing_products` as `stripe:test`. The bootstrap does not write the database,
enable SaaS, create subscriptions, or configure live billing.

Local validation: `node --test test/stripe_bootstrap.test.mjs`. All tests use mocks
or credential-free/invalid-key CLI subprocesses. Real integration is the guarded
operator workflow above: check is read-only and no network mutation occurs unless
`--apply-test-mode` is explicitly supplied. After an authorized apply, a second
check should report `reuse` for all three paid plans.

### Stripe TEST webhook operator workflow (2026-10-03)

The authoritative route is `POST /api/billing/webhook` in
`src/saas/billing.mjs`, registered in `src/index.js` **before** `express.json()`.
`cloudflare/worker.js` forwards the original request to the existing API container;
it does not implement a second billing owner. Confirm the selected sandbox HTTPS
origin reaches this revision and preserves request bytes and `Stripe-Signature`.
The historical production URL below is not a verified sandbox target.

```sh
node scripts/configure-stripe-test-webhook.mjs --check
node scripts/configure-stripe-test-webhook.mjs --dry-run
# Only after inspecting the proposed test action:
node scripts/configure-stripe-test-webhook.mjs --apply-test-mode
```

Supply `BILLING_MODE=test`, `STRIPE_SECRET_KEY` (an explicit `sk_test_` key),
`STRIPE_TEST_WEBHOOK_URL=https://<isolated-test-api>/api/billing/webhook`, and
`SAAS_ENABLED=0` through the operator process environment. The utility does not
load `.env`, select a production origin, alter runtime flags, or write a database.
No credentials or missing URL/mode yields a deterministic offline check and an
exact manual blocker; apply with incomplete configuration fails. Check/dry-run
with complete configuration lists endpoints read-only. Apply creates a missing
TEST endpoint or reuses one enabled endpoint with exactly the five supported
events. Live/restricted/unknown keys, non-test mode, non-HTTPS/wrong-path URLs,
URL credentials/query/fragment, duplicate endpoints, disabled endpoints and event
configuration conflicts fail closed. Resolve conflicts manually in the selected
test Dashboard; this utility never updates or deletes existing endpoints.

Creation uses a deterministic URL-based idempotency key; run one operator at a
time. After a timeout, rerun check before apply. A successful create can remain
even if the local command failed afterward. Listing discovers that endpoint on
rerun; Stripe idempotency retention is finite. Output whitelists endpoint ID,
URL, event names and action, and never returns the SDK response or signing secret.
See the [Stripe endpoint API](https://docs.stripe.com/api/webhook_endpoints/create)
for endpoint creation and signing-secret semantics.

**Manual blocker:** in the matching Stripe test sandbox, securely copy the chosen
endpoint's signing secret into the isolated backend's `STRIPE_WEBHOOK_SECRET`.
Do not paste it into commands, tickets, logs, or this repository. The tool never
stores it, and reuse cannot recover it. Finish the existing reviewed test schema,
customer link and `stripe:test` price configuration. Set
`BILLING_WEBHOOK_ENABLED=1` only on that isolated backend, keeping `SAAS_ENABLED=0`.
This opens ingestion and the existing authenticated operator recovery routes;
Checkout and ordinary SaaS flows remain gated. Deliver actual test lifecycle
events and record event IDs, endpoint ID, HTTP outcomes and ledger transitions
without secrets. No real endpoint or delivery was verified by local mock tests.

Reconciliation contract and sandbox acceptance:

- Created/updated events retrieve the current subscription **after** locking the
  linked customer's account row. The returned subscription ID, customer and mode
  must match the signed event. Only active/trialing subscriptions with exactly one
  configured price and a valid billing period grant a plan. Unknown customers,
  unmapped/ambiguous active prices and identity/mode mismatches roll back the
  event ledger and entitlement transaction, returning retryable failure evidence.
- Deleted events use the signed canceled snapshot, without requiring a provider
  lookup. They remove subscription access even when the price is missing; unknown
  prices never grant access. A deletion for a replaced subscription cannot cancel
  its replacement. Role and manual override columns are untouched.
- Duplicate event IDs are transactional and produce no repeated transition or
  notification. Earlier event timestamps are acknowledged as stale. Equal-second
  updates retrieve current state under the same account lock; a same-second
  update cannot resurrect a canceled subscription. Event IDs are not ordered as
  timestamps. Settled retries clear previous failure records.
- Incomplete, past-due, unpaid, paused and canceled subscriptions fall back to Free.
  Exercise renewal periods, upgrade/downgrade prices, cancellation scheduling and
  resume. Invoice paid/failed events notify once and never grant a plan. Unsupported
  event types are acknowledged and ignored; Checkout redirects are not payment proof.
- Retry a transient failure with the same event ID, then verify one transition and
  one notice. Use `POST /api/admin/recovery/billing-events/:id/replay` with an audited
  reason for recorded failures, or `/api/admin/recovery/billing/:id/reconcile` with
  a reason and stable `requestKey` for current state. Both reuse the billing owner,
  read Stripe only, and require existing authenticated admin authorization.

Focused validation command:

```sh
node --test test/stripe_webhook.test.mjs test/stripe_bootstrap.test.mjs test/saas.test.mjs test/saas_launch.test.mjs test/saas_readiness.test.mjs
```

The webhook suite uses signed HTTP requests, serialized rollback-capable SQL
mocks, mocked Stripe responses, and CLI subprocesses with no real credentials.
Existing PostgreSQL suites additionally require the dedicated loopback
`TEST_SAAS_DATABASE_URL`; skipped suites are not evidence of real database behavior.
Real sandbox delivery, dashboard configuration, deployed secrets and subsequent
production release approval remain external Priority 1 gates.

| Configuration | Location / source | Verified status and required action |
| --- | --- | --- |
| `SAAS_ENABLED` | Server runtime | Local value off; keep `0` throughout preparation. Deployed bindings require separate inspection. |
| `BILLING_MODE`, `STRIPE_SECRET_KEY` | Server secret; Stripe account | Production live key/mode not configured. Use a separate test environment for sandbox lifecycle tests; never mix test IDs and live keys. |
| `STRIPE_WEBHOOK_SECRET` | Server secret; endpoint signing secret | Not configured. Historical production route: `https://api.ysong.ai/api/billing/webhook`; explicitly choose and verify an isolated test origin using the workflow above. |
| `BILLING_WEBHOOK_ENABLED` | Server runtime | Currently off. A separately approved `1` allows signed ingestion and operator recovery while SaaS remains off; it does not enable Checkout or grant access by itself. |
| `STRIPE_PORTAL_CONFIGURATION_ID` | Server; Stripe portal configuration | Not configured. Review payment management, switching, cancellation, resumption and downgrade timing before using the selected configuration. |
| `BILLING_RETURN_URL`, `BILLING_SUCCESS_URL`, `BILLING_CANCEL_URL` | Server; frontend HTTPS URLs | Explicit production values required. Success/cancel must share the return origin. Returning from Checkout is never proof of payment. |
| Stripe products/prices | `ysong_plans.billing_products` and `billing_prices`, separate `stripe:test` / `stripe:live` references | Actual IDs not configured. Basic/Pro/Premium require active USD monthly prices of 999/1999/2999 cents and matching actual product IDs. Free has no Stripe subscription. |
| Generation/assistant/storage limits and capabilities | Reviewed plan configuration JSON -> `ysong_plans` | Owner decisions required. Missing generation allowances fail closed; null storage is an explicit configuration choice, not an invented number. Available paid plans require real references. |

Plan IDs are fixed at `free`, `basic`, `pro`, and `premium`, with USD monthly prices of 0, 999, 1999, and 2999 cents. The reviewed configuration requires explicit generation, assistant, uploads, and disabled artwork capability flags. A published plan needs a positive generation allowance; assistant access needs an explicit assistant limit. Free access needs no paid subscription. Its production generation allowance is still unconfigured. Test and live Stripe references are stored separately, and a missing mode-specific price or product makes a paid plan unavailable. `NULL` generation quota means unconfigured and blocks generation; it never means unlimited. Keep `SAAS_ENABLED=0`.

For a cost assessment, run `node scripts/quota-report.mjs --file <cost-input.json>`. Supply `providerCostEvidence` entries with `provider`, `model`, `source`, and positive `costCentsPerGeneration`, a `safetyMultiplier` of at least 1, and nonnegative integer `monthlyCostBudgetCents` for all four plans. The report uses the highest evidenced unit cost and floors budget divided by that cost and the multiplier. Missing evidence yields `insufficient_evidence` and null production quotas. Recommendations do not configure or approve commercial allowances; confirm the provider cost scope, generation mix, margin, and owner budget before setting production quotas. The existing `test/saas_readiness.test.mjs` allowances of five generations and two assistant requests are **test-only fixtures** for isolated sandbox verification, not production values.
| Superadmin identity | Stored active account UUID after the additive migration | Validate exactly one immutable superadmin. Bootstrap email is initialization input, not an ongoing privilege rule. Never grant by client claims or email resemblance. |
| Six policies | `ysong_policy_versions` | Attorney-reviewed text, immutable version URL and approval reference required for terms/privacy/upload/billing/generated/Bridge. Draft/placeholder versions cannot be accepted even if their approved boolean is changed. |
| Database/schema | Existing server `DATABASE_URL`; explicit target host in reviewed JSON | Neon connectivity passes; new SaaS tables/migration marker are not applied in production. |
| Auth/CORS/provider/R2/Resend | Existing server bindings | Local presence and read-only production health/CORS/R2 checks pass. Preserve credentials; no values belong in Vite, tracked configuration or logs. New deployment bindings remain a manual check. |
| Frontend API origin | Existing Vercel frontend configuration | Verify the intended production API and deployed revision during release. Hosted Checkout uses a returned URL; this app does not need a Stripe publishable key or Stripe.js. |

The JSON example deliberately contains incomplete values. Copy `docs/saas-launch-config.example.json` to an operator file, enter actual decisions/references, and run `node scripts/configure-saas.mjs --file <reviewed-file> --check`. This check makes no database/provider call. Keep filled operational files outside the reviewed source tree. Do not place secrets in this JSON.

Stripe dashboard checklist: review products/prices and tax settings, receipts/invoice email settings, refund/proration/cancellation terms, eligible Link/payment methods and portal products before release. Required webhook events are `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid` and `invoice.payment_failed`. Invoice notifications do not grant a plan; current verified subscription state determines entitlement. Duplicate events are deduplicated, stale events cannot roll state back, and subscription reconciliation reads Stripe without creating a subscription or charge. See [Stripe event types](https://docs.stripe.com/api/events/types) and [hosted Checkout sessions](https://docs.stripe.com/api/checkout/sessions).

## Future release order — each production action needs its release approval

1. Review the full dirty Git state and secrets, the complete SQL, and the retired VM workflow. Obtain a Neon recovery snapshot and record the last known good Worker/frontend revisions. Finish approved policy text, public agent/contact and delivery procedures before enabling customer flows.
2. Configure and test Stripe in an isolated sandbox. Exercise incomplete/payment failure, active/trialing, renewal, cancellation/resume, upgrades/downgrades, portal redirects, duplicate/stale events and invoice notices. Local fixtures cover logic, not dashboard settings or real delivery. No live subscription/charge is needed or authorized for this preparation.
3. Review server bindings, including the new optional billing URLs, portal configuration and ingestion flag. Keep `SAAS_ENABLED=0`; keep ingestion off until schema/configuration are ready.
4. From `D:\YSong\ysong-auth-api`, follow the [migration safety procedure](saas-migration-safety.md). Run `node scripts/migrate-saas.mjs --check --target C:\approved\ysong-production.json` with an independently reviewed target. A separately authorized `--apply` with the same target requires explicit `SAAS_ENABLED=0`, matching database identity and compatible schema. The additive SQL includes account/plan/quota/billing, durable jobs, rights/moderation/policies, notifications, immutable bootstrap and migration markers. It never runs at startup and preserves existing account/client-state/project/media rows and IDs.
5. Verify the stored admin UUID and intended target host. Review the completed JSON with `--check`; separately approved `node scripts/configure-saas.mjs --file <reviewed-file> --apply` verifies actual Stripe prices/products and the database host, then applies plan/policy configuration plus audit in one transaction. It requires SaaS off. Existing approved versions cannot be silently rewritten; publish a new version instead.
6. Deploy the reviewed API through the existing `cloudflare` package's `npm run deploy` only after release approval. Deploy the reviewed frontend through the existing Vercel project/release process. Verify all new runtime bindings and actual revisions; local source checks do not prove deployed configuration.
7. Run `node scripts/saas-preflight.mjs --remote`, then authenticated normal/admin/superadmin walkthroughs in the approved environment. Validate existing login/library/World reads, ownership restrictions, policies/reacceptance, recovery/audit, redirects/inbox, public-media cache revocation and legacy rights backfill. Use existing verified artifacts or mocked generators for render/quota/recovery walkthroughs; never silently submit paid smoke tests.
8. Separately authorize signed webhook ingestion while SaaS is off, then verify delivery/mode/ledger behavior using legitimate events in that environment. Sandbox delivery is not proof of live-mode configuration. Do not create a live subscription merely to obtain an event; any missing live verification remains a launch gate.
9. Enable SaaS only after every production gate is actually verified and the owner explicitly approves enablement. Controlled billing/AI calls require their own authorization. A passing local test or configuration-presence check cannot advance readiness to C or D.

Existing users retain identity, client state, projects, uploads, libraries and IDs. Normal accounts default to active Free with no subscription; absence of a subscription does not break login. New Free initialization is idempotent. Existing generations are not retroactively charged. Configured Free capabilities/limits determine future costly actions. Superadmin remains exempt; normal users cannot claim exemptions. Legacy public rights evidence/cache review remains a separate release gate, not automatic approval of old content.

## Operator recovery without ordinary direct SQL edits

All recovery mutations require an active admin/superadmin, an explicit reason, server-side validation and immutable audit. They are available when SaaS or approved webhook ingestion is enabled. The admin account surface exposes recovery; backend guards are authoritative. First drain old runtime instances: old executors do not acquire the new advisory lock. A new active executor is protected by that lock; elapsed time alone is not proof of failure.

| Problem | Supported operator action and guard |
| --- | --- |
| Stopped standalone/session submission stranded in processing | `POST /api/admin/recovery/generations/:id/review-submission`: marks uncertain, retains reservation, records audit/inbox. No replacement render or automatic refund. |
| Definitely unsubmitted queued work | `.../generations/:id/cancel-queued`: cancels/releases once; submitted work is ineligible. |
| Ready audio but project save failed | `.../generations/:id/finalize`: session only, all parts terminal and at least one ready. Reuses stored artifacts; queued parts cannot trigger paid generation through this action. |
| Ambiguous part with evidence | Existing `/api/admin/generations/:id/parts/:part/resolve` route: verify exact owned deterministic artifact, or explicit failure evidence. Never fabricate provider job lookup or infer failure from delay. |
| Reservation-counter mismatch | `.../quota/:periodId/recount-reservations`: optimistic expected counter, recomputes original-period reserved ledger, includes uncertainty and preserves used credits. No arbitrary refund/credit. |
| Subscription snapshot stale | `.../billing/:accountId/reconcile`: stable request key, reads linked current Stripe subscription, verifies owner/mode, audits transaction. No subscription creation/charge. |
| Missing billing profile | `.../billing/:accountId/link-profile`: explicitly supplied provider IDs, exact server user UUID in Stripe customer metadata, mode/ownership checks; refuses conflicting existing linkage. Linking alone grants nothing. |
| Verified webhook processing failed | `.../billing-events/:eventId/replay`: persisted verified failure only, retrieves provider event/current state, deduplicates/stale-checks, records audit/resolution. Invalid signatures never become replay candidates. |
| Moderation/takedown state | Existing reasoned admin review/decision routes preserve media/IDs and enforce rights checks. Appeal/restoration must consider other blocked evidence. |
| Formal notice delivered or failed | `.../takedowns/:caseId/notification`: manual receipt/reference + optimistic case timestamp. Records evidence, does not send an email or assert delivery without evidence. |

Operator requests are authenticated actions, not public curl examples containing tokens. Recovery UI retains stable request keys across interrupted requests; API idempotence and locks remain the source of safety.

## Notifications and legal gates

Existing inbox storage is reused with deterministic IDs: invoice payment/failure, subscription status/plan/cancellation changes, generation completion/partial/failure/manual review, moderation/takedown and account restriction changes. Replay does not duplicate notices. Existing job checkpoint writes remain primary if an inbox write fails. This is not a new mass-email service; Resend verification delivery remains unchanged. Stripe receipt/invoice emails must be verified in its dashboard. Banned users cannot read the authenticated inbox until restored, so critical restrictions require reviewed human outreach and delivery evidence.

Attorney/owner approval is still required for actual policy text, privacy/data retention and subprocessors, generated-output rights/limitations, upload authorization, billing/refunds/cancellation/taxes, Bridge/plugin licensing, public designated-agent registration/contact, notice/counter-notice requirements, statutory deadlines/litigation holds and repeat-infringer appeals. Authenticated case intake alone is not a complete public DMCA process. Human references do not prove counsel approval. See [Copyright Office section 512](https://www.copyright.gov/512/index.html). Pending formal notices are tracked with evidence; no notice has been sent by this pass.

## Rollback and current evidence

Keep SaaS off if any gate fails. Roll back application revisions using the recorded known-good Worker/Vercel releases; do not drop additive tables or delete artifacts. Decide explicitly whether verified webhook ingestion should continue while Checkout is disabled, so legitimate billing events are not silently lost. Retain ledger/audit and restore reviewed configuration with a new recorded action/version rather than rewriting approved policy history. Database recovery from a snapshot requires a separate incident plan and must account for newer writes.

The local retired `.github/workflows/deploy.yml` has manual dispatch only and no SSH/rsync/VM restart or push deployment. It has not been pushed, so the remote workflow is unchanged. Any future approved push must include that replacement. No automatic Cloudflare deployment workflow was added.

Latest read-only preflight: B, exit 1 intentionally. API health, Neon health, allowed-origin CORS, R2 metadata read and frontend login page pass. Local tracked-known-secret and retired-workflow checks pass; neither is a full history/untracked secret audit. Production SaaS schema/configuration, Stripe/portal/webhook/redirects, allowances and approved policies remain incomplete. Dashboard, authenticated deployed behavior, formal legal delivery, public rights/cache, final Git/release approval remain manual gates. No production configuration/schema/flag was changed and no paid call, live charge, deployment, commit or push occurred.
