# Production Neon migration safety

The migration defaults to a read-only check. `--check` and `--status` are aliases.
Neither executes schema SQL, creates temporary objects, backfills users, or uses
a write transaction. Blockers exit 1; a compatible check exits 0. Pending objects
are expected before first apply. A successful check is not SaaS launch readiness.
Keep `SAAS_ENABLED=0`: the tool never changes flags, deploys, or configures billing.

## Target review and check

Independently obtain the intended endpoint from the Neon project/branch dashboard,
database and role from approved server configuration, and superadmin UUID from an
authorized account lookup. Verify the endpoint belongs to the production branch;
do not simply copy an arbitrary configured connection into the approval file.
Create local JSON outside tracked source, without credentials:

```json
{
  "environment": "production",
  "databaseHost": "ep-REPLACE.REGION.aws.neon.tech",
  "databaseName": "neondb",
  "databaseUser": "REPLACE",
  "schema": "public",
  "superadminUserId": "REPLACE_WITH_EXISTING_UUID"
}
```

Placeholders deliberately fail validation. No production target is checked in or
automatically selected. `DATABASE_URL` must match the endpoint, database and role
exactly. Only PostgreSQL URLs, Neon endpoints on port 5432, and optional
`sslmode=require`/`verify-full` are accepted. Certificate verification is always
enabled independently of `PGSSL`; redirecting connection options are rejected.
Connected database, role, schema and non-replica status are verified. The reviewed
endpoint plus verified TLS identifies the Neon endpoint; PostgreSQL cannot attest
the operator's production project/branch label.

```powershell
$env:SAAS_ENABLED='0'
node scripts/migrate-saas.mjs --check --target C:\approved\ysong-production.json
node scripts/migrate-saas.mjs --status --target C:\approved\ysong-production.json
```

The process flag must be explicitly `0`; the operator must independently verify
the deployed Worker binding is off as well. The report identifies endpoint,
database and schema; lists pending/applied tables, columns, indexes, plans and
markers; counts existing/pending accounts; and verifies the superadmin UUID.
Passwords, connection strings, login roles, emails, UUIDs and row contents are
not printed. Driver errors are redacted into safe SQLSTATE explanations. Missing
target approval blocks before connection. Local tests do not attest production.

## Guarded apply

Record a Neon recovery point and deployed revisions through the existing release
procedure. Verify deployed SaaS is off, drain writers during an approved
maintenance window, and review a successful check. The existing explicit
`--apply` flag is the operator acknowledgement; there is no implicit apply:

```powershell
node scripts/migrate-saas.mjs --apply --target C:\approved\ysong-production.json
```

Apply repeats the checks inside a transaction. An advisory lock serializes
migrations; `SHARE ROW EXCLUSIVE` locks on existing ordinary tables block writers
while allowing reads. Lock timeout is 5 seconds, and each statement has a 30-second
timeout. Busy or large databases may block apply. Review maintenance timing and
load rather than bypassing a blocker.

The SQL hash must match the reviewed `src/saas/schema-manifest.json`. Existing
columns, types, defaults, nullability, constraints and valid indexes must match
the manifest. Missing objects must have explicit create/add statements. Unexpected
SaaS columns/constraints/indexes, triggers, rules, RLS, unknown migration markers,
and enabled database event triggers block. `IF NOT EXISTS` does not establish
compatibility. PostgreSQL-version definition differences can conservatively block
and require offline review; do not improvise SQL or regenerate from production.

Users must have a UUID primary key and compatible email column. Missing accounts
are backfilled as active Free without subscriptions. Missing plans use the existing
product prices; existing catalog rows, including NULL prices, quotas and manual
configuration, remain untouched. Pending unique indexes check duplicate billing
customer mappings and active policy versions. Commercial activation remains a
separate gate.

First bootstrap requires exactly one email match to the independently reviewed
UUID. A stored active superadmin survives email changes. `ysong_saas_bootstrap`
pins that UUID for subsequent checks. Missing, multiple, inactive or replaced
identities block instead of promoting a new email owner. The stored role remains
the application's authorization source. The pin is a migration invariant, not
protection against a database administrator deliberately editing both records.

World/Band/release/project/client-state tables are never altered by this SQL.
Apply compares row counts and aggregate row fingerprints for non-SaaS tables and
the shared World notifications table before/after under locks. Fingerprints stay
internal and are corruption checks, not backups. Post-apply schema, account
coverage, identity and markers must pass before commit. Errors roll back the
transaction. Replay fills missing objects/new accounts without overwriting old
rows. Never recover a launch by dropping these tables; keep SaaS off and use the
established recovery procedure.

If the connection loses the commit acknowledgement, the tool reports an unknown
outcome rather than claiming rollback. Run a read-only check and inspect database
state before retrying.

## Local validation and manifest maintenance

Tests require a dedicated loopback PostgreSQL database, never production. They
do not load `.env` for their connection and retain random fixture schemas. The
new integration test fails instead of silently skipping when its URL is absent.

```powershell
$env:TEST_SAAS_DATABASE_URL='postgres://FIXTURE_USER:FIXTURE_PASSWORD@127.0.0.1:55432/ysong_saas_validation'
node --test test/saas_migration.test.mjs test/saas.test.mjs test/saas_launch.test.mjs test/saas_readiness.test.mjs
```

Only for an intentionally reviewed SQL change, run
`node scripts/saas-migration-manifest.mjs` against this local fixture. The helper
rejects remote hosts, other database names and connection options. It applies
twice in a new isolated schema and records the catalog. Generation is not a safety
proof: review SQL and manifest diffs, then test preservation, replay, older-schema
upgrades, read-only operation, target/flag gates, bootstrap, drift, concurrent
apply and rollback. Never use regeneration to bless an unreviewed mismatch.

Validation on 2026-10-03: all 175 API tests passed, zero skipped, using the current
product Dockerfile (including ffmpeg) and isolated local PostgreSQL 16. The job
fixture now supplies a separate bootstrap admin while its quota subjects remain
ordinary users. No production check or apply was performed: no independently
reviewed production target/UUID file or operator apply acknowledgement was
supplied. SaaS was not enabled.
