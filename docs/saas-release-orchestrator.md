# Guarded SaaS release command

After merging this change into a clean committed `main` checkout, the operator runs:

```sh
SAAS_ENABLED=0 node scripts/release-saas.mjs --target /approved/production-target.json --config /approved/launch-config.json
```

This default command checks the independently reviewed Neon target, clean repository,
retired VM workflow, migration status, launch configuration, Cloudflare build, and
final read-only preflight in that order. It does not apply or deploy. Supply the
database connection and other server settings through the approved process
environment; keep reviewed JSON outside tracked source. Any failed gate stops the
sequence. Preflight's manual gates can still make the command exit 1.

Only after separate production authorization, recovery point, dashboard review,
and maintenance scheduling may an operator add all of
`--apply-migration --apply-config --deploy --acknowledge-release --remote` to that
same command. Each apply delegates to its existing owner; Cloudflare deploy uses
the existing helper, which requires clean committed `main`. The final preflight
does read-only checks. This command never changes `SAAS_ENABLED`; enabling SaaS is
a separate explicit final action after all manual evidence passes. The orchestrator
suppresses subprocess output because owner tools or providers may include secrets.
