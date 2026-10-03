# SaaS production launch runbook — local preparation only

2026-10-02. Readiness **B: ready for billing configuration**. SaaS stays disabled. Nothing in this document authorizes applying a production migration, enabling billing, deploying, committing, pushing, charging a customer or calling a paid generator. Preserve the completed Cloudflare/R2/Neon/Vercel/Resend architecture and migration evidence.

## Configuration matrix

| Configuration | Location / source | Verified status and required action |
| --- | --- | --- |
| `SAAS_ENABLED` | Server runtime | Local value off; keep `0` throughout preparation. Deployed bindings require separate inspection. |
| `BILLING_MODE`, `STRIPE_SECRET_KEY` | Server secret; Stripe account | Production live key/mode not configured. Use a separate test environment for sandbox lifecycle tests; never mix test IDs and live keys. |
| `STRIPE_WEBHOOK_SECRET` | Server secret; endpoint signing secret | Not configured. Endpoint is `https://api.ysong.ai/api/billing/webhook`; verify signed raw-body delivery. |
| `BILLING_WEBHOOK_ENABLED` | Server runtime | Currently off. A separately approved `1` allows signed ingestion and operator recovery while SaaS remains off; it does not enable Checkout or grant access by itself. |
| `STRIPE_PORTAL_CONFIGURATION_ID` | Server; Stripe portal configuration | Not configured. Review payment management, switching, cancellation, resumption and downgrade timing before using the selected configuration. |
| `BILLING_RETURN_URL`, `BILLING_SUCCESS_URL`, `BILLING_CANCEL_URL` | Server; frontend HTTPS URLs | Explicit production values required. Success/cancel must share the return origin. Returning from Checkout is never proof of payment. |
| Stripe products/prices | `ysong_plans.billing_products` and `billing_prices`, separate `stripe:test` / `stripe:live` references | Actual IDs not configured. Basic/Pro/Premium require active USD monthly prices of 999/1999/2999 cents and matching actual product IDs. Free has no Stripe subscription. |
| Generation/assistant/storage limits and capabilities | Reviewed plan configuration JSON -> `ysong_plans` | Owner decisions required. Missing generation allowances fail closed; null storage is an explicit configuration choice, not an invented number. Available paid plans require real references. |
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
4. From `D:\YSong\ysong-auth-api`, a separately authorized `node scripts/migrate-saas.mjs --apply` applies the existing single additive `src/saas/schema.sql`. Ordered additions include account/plan/quota/billing, durable jobs, rights/moderation/policies, notification/recovery columns and `launch-preparation-v1`. There is no automatic startup SaaS migration. Existing account/client-state/project/media tables are preserved.
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
