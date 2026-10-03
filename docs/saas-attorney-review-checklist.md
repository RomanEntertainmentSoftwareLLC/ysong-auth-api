# ATTORNEY REVIEW REQUIRED

No policy in this repository is approved by this checklist. Keep SaaS disabled until counsel and the operator complete all items with real evidence.

1. Review and publish immutable HTTPS versions of Terms, Privacy, subscription/billing terms, generated-output terms, upload/content-rights terms, and Bridge/software license. Record each version, URL, and attorney approval reference in the reviewed configuration. Confirm provider licenses, payment/refund/cancellation/tax disclosures, data retention and processors.
2. Review and publish immutable HTTPS references for DMCA/takedown procedure, repeat-infringer policy, and moderation rules. Confirm the designated-agent registration and public contact, notice and counter-notice delivery, appeals, deadlines, and preservation procedure. Assign a human operator for notices and record delivery evidence.
3. Run `node scripts/configure-saas.mjs --file <reviewed-file> --check`, then separately apply the reviewed configuration with SaaS disabled. Run `node scripts/saas-preflight.mjs --remote` and verify every `Approved policy:` gate plus the manual legal procedure gate. Stored references and a passing presence check do not prove attorney review.

The three operational references are launch gates, not account acceptance prompts. The six user-facing policies are versioned acceptance prompts; stale and draft versions cannot be accepted.

## Interrupted-task recovery validation

Recovered the existing saas-legal-launch-gate diff without resetting, stashing, or discarding it. Fixed swapped URL/required SQL parameters and hardened canonical approved-policy checks. Nine references are mandatory in reviewed launch configuration and preflight; six remain explicit user acceptance prompts. Missing approval evidence reports ATTORNEY REVIEW REQUIRED; present references still require MANUAL ACTION REQUIRED human verification. No attorney approval is established by fixtures or automated checks.

Validation: initial focused policy/configuration/preflight/launch/Stripe-bootstrap run passed 41 tests, zero skipped. Final broader SaaS plus Stripe-bootstrap run passed 81 tests, zero skipped, with isolated PostgreSQL and mocked billing/providers. Additional assertions cover real stored URLs and acceptance flags, missing operational references, and rejection of operational-policy acceptance. Syntax, schema-manifest digest and git diff --check pass. SaaS remains disabled; tests explicitly use SAAS_ENABLED=0. No production migration, deploy, push, Stripe charge or paid AI/music call occurred. The preserved local validation container was stopped after testing.
