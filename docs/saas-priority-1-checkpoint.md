# Priority 1 SaaS launch checkpoint — 2026-10-03

**Decision: keep `SAAS_ENABLED=0`. Readiness is B (billing configuration preparation), not authorization to deploy, sell access, or enable SaaS.** This is the current launch-gate index for this repository. Use [saas-production-launch.md](saas-production-launch.md) for the release sequence and operator recovery procedure. The long [productization handoff](saas-productization-handoff.md) records historical passes; its older dirty-tree, unimplemented batch worker, and active VM workflow statements are superseded by this checkpoint and current source. The baseline inspected here is committed `b947404`, with a clean worktree before this documentation update.

## Implemented in the committed source

- `src/saas/schema.sql` and explicit `scripts/migrate-saas.mjs --apply` provide additive plans, account access, quota periods, generation lineage, billing/audit/usage ledgers, policy and rights records, takedowns, notifications, recovery state, and the `launch-preparation-v1` marker. Migration is not run at startup. Commercial quotas and Stripe references are deliberately unconfigured.
- `src/saas/service.mjs`, `jobs.mjs`, and the music integration in `src/index.js` enforce server owned reservations, per usable version charging, idempotency, durable artifacts, whole-session jobs, progress, partial results, project finalization, and owner scoped history. Submitted or uncertain work retains its reservation until evidence based reconciliation. Standalone work stranded during a process crash still needs operator review.
- `billing.mjs` and `routes.mjs` provide guarded hosted Checkout, portal sessions, signed raw-body webhook verification, event deduplication, mode separation, subscription based entitlements, account/admin controls, and audit. `metering.mjs` meters configured assistant request units; other unsupported paid executors fail closed for ordinary SaaS accounts. These are code paths and local tests, not proof of Stripe dashboard or deployed behavior.
- `governance.mjs`, `policies.mjs`, `recovery.mjs`, and `notifications.mjs` provide policy acceptance, rights attestation, manual moderation/takedown cases, audited recovery operations, and in-app notices. Image inspection queues review; it does not classify explicit pixels or establish ownership. Formal notice delivery still needs human evidence.
- `.github/workflows/deploy.yml` is committed with `workflow_dispatch` only. Its sole job prints a retirement message; there is no push trigger, SSH, rsync, or VM restart. Any remote workflow revision still depends on a future push, which this task does not perform.

## Work that can be automated now, with SaaS off

1. Run source and focused mocked tests, syntax checks, `git diff --check`, and the local workflow audit. Existing tests exercise PostgreSQL fixture transactions where available; paid provider calls are mocked.
2. Fill an untracked operator copy of `saas-launch-config.example.json` with owner supplied values, then run `node scripts/configure-saas.mjs --file <file> --check`. This checks structure only and makes no database or provider call. It cannot approve policy text or validate Stripe objects.
3. Run `node scripts/saas-preflight.mjs` as a **read-only gap report** against the intentionally selected configured database. It audits local auth and sibling web source plus environment and database state, so its scope extends beyond this repository. Its expected exit is 1 while gates are incomplete; do not treat that expected launch result as a failed code test or as permission to change a database. `--remote` adds read-only public health, CORS, R2 listing, and frontend reachability checks.
4. Prepare mocked normal/admin/superadmin walkthrough scripts and recovery evidence. Do not automatically retry or refund ambiguous paid work. Full deployed behavior and actual notices cannot be inferred from mocks.

## External launch gates, in dependency order

| Gate | Required evidence / owner |
| --- | --- |
| Commercial and legal decisions | Owner sets Free/Basic/Pro/Premium capabilities, generation and assistant limits, storage policy, availability, taxes/refunds/cancellation and customer support. Counsel approves six policy texts and version references, privacy/retention, upload/generated-output and Bridge rights, public designated-agent/contact, notice/counter-notice and repeat-infringer process. Draft policies are not approved. |
| Stripe **test** credentials | Operator supplies matching `sk_test_` key, webhook signing secret, test product and recurring price IDs, and portal configuration in an isolated test environment. Exercise signed subscription and invoice events, Checkout/portal redirects, payment failure, renewal, cancellation/resume, upgrades/downgrades, duplicate/stale delivery, and inbox/receipt behavior. Local fixture tests cannot establish these dashboard and delivery facts. No live charge is needed for this gate. |
| Production migration and configuration | Separately approved Neon recovery snapshot and exact target review precede `migrate-saas.mjs --apply`. Verify marker, one stored active superadmin UUID, and preserved existing accounts/projects. Reviewed `configure-saas.mjs --apply` requires matching database host and billing mode, actual Stripe objects, audited atomic plan/policy configuration, and SaaS off. Review server secrets, webhook ingestion, R2/provider/Resend bindings and frontend API origin. No migration or configuration apply occurred in this checkpoint. |
| Deployment and operational verification | Approve and deploy reviewed Cloudflare Worker and Vercel revisions by their existing manual processes; verify deployed bindings and revisions. Run remote preflight and authenticated account, quota, job restart/partial/recovery, library/project/DAW, billing, moderation, rights/cache, notifications and rollback walkthroughs. Keep `SAAS_ENABLED=0` until every gate is evidenced and the owner explicitly authorizes enablement. No deployment occurred in this checkpoint. |

The preflight label B means preparation can continue; its implementation returns B whenever there is no explicit FAIL, even if gates are `NOT CONFIGURED` or `MANUAL ACTION REQUIRED`. It is **not** a release grade. Production state cited in the 2026-10-02 runbook is historical evidence, not a fresh production check here. The current committed `.env.example` sets `SAAS_ENABLED=0` and `BILLING_WEBHOOK_ENABLED=0`; actual deployed secrets, schema, and flag must be checked during release.

## Next Priority 1 action

### Stripe webhook hardening checkpoint (2026-10-03)

The existing Express billing owner now checks subscription identity/customer/mode,
serializes authoritative Stripe reads under the account lock, and handles
same-second cancellation without resurrecting access. Created/updated/deleted,
duplicate/stale/retried events, unknown customer/active price, invoice notices and
audited recovery have credential-free signed HTTP and transactional mock coverage.
No schema or runtime flag change is required; `SAAS_ENABLED=0` remains the gate.

`node scripts/configure-stripe-test-webhook.mjs --check` is the deterministic
operator entry point. With explicit test key/mode and `STRIPE_TEST_WEBHOOK_URL`, it
inspects read-only; only `--apply-test-mode` can create a missing TEST endpoint.
It reuses a matching endpoint, rejects conflicts/live credentials and never prints
or stores the signing secret. Follow the exact environment, secret-transfer and
delivery checklist in the [TEST webhook workflow](saas-production-launch.md#stripe-test-webhook-operator-workflow-2026-10-03).

Local focused result: 24 passed, 3 PostgreSQL suites skipped because the dedicated
fixture database was not supplied; the 8 new webhook/operator tests all passed
without skips. This is mock evidence, not verified Stripe delivery. The remaining
blocker is operator-supplied sandbox credentials and HTTPS owner URL, secure
installation of the endpoint signing secret, reviewed test database configuration,
and recorded real lifecycle deliveries with SaaS still off. No endpoint creation,
deployment, live billing operation or push occurred in this task.

Obtain the commercial/legal inputs and isolated Stripe test setup, then complete the sandbox lifecycle and evidence based operator walkthrough. Preserve the production migration and deploy gates in the runbook. Do not start Priority 2 work or enable SaaS based on local green tests.
