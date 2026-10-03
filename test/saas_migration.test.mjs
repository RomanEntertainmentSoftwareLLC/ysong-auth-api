import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { identifyTarget, parseArgs, inspectCatalog, readCatalog, runMigration, quote, digest } from '../src/saas/migration.mjs';

const sql = await fs.readFile(new URL('../src/saas/schema.sql', import.meta.url), 'utf8');
const manifest = JSON.parse(await fs.readFile(new URL('../src/saas/schema-manifest.json', import.meta.url), 'utf8'));
const admin = '00000000-0000-4000-8000-000000000001';
const user = '00000000-0000-4000-8000-000000000002';
const target = { environment: 'production', databaseHost: 'ep-fixture.us-east-2.aws.neon.tech', databaseName: 'neondb', databaseUser: 'owner', schema: 'public', superadminUserId: admin };
const env = { DATABASE_URL: 'postgres://owner:secret_fixture@ep-fixture.us-east-2.aws.neon.tech/neondb?sslmode=require', SAAS_ENABLED: '0' };

test('CLI defaults read-only and requires existing --apply acknowledgement without accepting ambiguous flags', () => {
  assert.equal(parseArgs([]).mode, 'check');
  assert.equal(parseArgs(['--status']).mode, 'status');
  assert.equal(parseArgs(['--apply', '--target', 'review.json']).mode, 'apply');
  for (const args of [['--apply', '--check'], ['--apply', '--apply'], ['--force'], ['--target'], ['--target', '--apply']]) assert.throws(() => parseArgs(args));
  for (const mode of ['--check', '--status', '--apply']) {
    const r = spawnSync(process.execPath, ['scripts/migrate-saas.mjs', mode], { encoding: 'utf8', env: { ...process.env, ...env } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no connection attempted/);
    assert.ok(!`${r.stdout}${r.stderr}`.includes('secret_fixture'));
  }
});

test('target requires exact independent identity, explicit off and verified TLS', () => {
  const result = identifyTarget(env, target);
  assert.equal(result.connection.ssl.rejectUnauthorized, true);
  assert.ok(!JSON.stringify(result.identity).includes('secret_fixture'));
  assert.ok(!JSON.stringify(result.identity).includes('owner'));
  for (const key of ['databaseHost', 'databaseName', 'databaseUser', 'schema', 'environment', 'superadminUserId'])
    assert.throws(() => identifyTarget(env, { ...target, [key]: 'wrong' }));
  for (const flag of [undefined, '', '1', 'true', 'false', 'off']) assert.throws(() => identifyTarget({ ...env, SAAS_ENABLED: flag }, target));
  for (const url of [env.DATABASE_URL + '&host=evil', env.DATABASE_URL.replace('require', 'disable'), env.DATABASE_URL.replace('ep-fixture.us-east-2.aws.neon.tech', 'localhost'), 'invalid'])
    assert.throws(() => identifyTarget({ ...env, DATABASE_URL: url }, target));
});

test('reviewed SQL is pinned and only additive DDL touches SaaS-owned objects', () => {
  assert.equal(digest(sql), manifest.sha256);
  assert.throws(() => inspectCatalog([], manifest, sql + '\nDELETE FROM users;'), /differs/);
  assert.doesNotMatch(sql, /\b(DROP|TRUNCATE|DELETE|RENAME)\s+(TABLE|FROM|COLUMN|TO)\b/i);
  assert.doesNotMatch(sql, /ALTER TABLE (?!ysong_)/);
  assert.doesNotMatch(sql, /UPDATE ysong_plans/);
  assert.deepEqual([...new Set([...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(m => m[1]))].sort(), manifest.tables.map(t => t.name).sort());
});

test('real PostgreSQL migration safety and replay', async t => {
  assert.ok(process.env.TEST_SAAS_DATABASE_URL, 'Required validation: set dedicated loopback TEST_SAAS_DATABASE_URL');
  const url = new URL(process.env.TEST_SAAS_DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname === '/ysong_saas_validation' && !url.search);
  const client = new pg.Client({ connectionString: url.href });
  await client.connect();
  t.after(() => client.end()); // Fixtures are retained for inspection.
  let schema, dbTarget;
  async function fixture(email = 'psychopathetica@gmail.com') {
    schema = `migration_test_${crypto.randomUUID().replaceAll('-', '')}`;
    await client.query(`CREATE SCHEMA ${quote(schema)}`);
    await client.query(`SET search_path = ${quote(schema)}, pg_catalog`);
    await client.query('CREATE TABLE users(id uuid PRIMARY KEY,email text)');
    await client.query('INSERT INTO users VALUES($1,$2),($3,$4)', [admin, email, user, 'existing@example.invalid']);
    for (const name of ['world_releases', 'world_tracks', 'bands', 'projects', 'user_client_state']) {
      await client.query(`CREATE TABLE ${quote(name)}(id uuid PRIMARY KEY,user_id uuid REFERENCES users(id),state jsonb)`);
      await client.query(`INSERT INTO ${quote(name)} VALUES($1,$2,$3)`, [crypto.randomUUID(), user, { nested: ['existing', 'catalog'], projectId: user }]);
    }
    dbTarget = { ...target, databaseName: url.pathname.slice(1), databaseUser: decodeURIComponent(url.username) };
  }
  const run = mode => runMigration(client, { mode, target: dbTarget, manifest, sql, schema });
  const allRows = async () => {
    const result = {};
    for (const row of (await readCatalog(client, schema)).filter(r => r.kind === 'r'))
      result[row.name] = (await client.query(`SELECT to_jsonb(t) AS row FROM ${quote(schema)}.${quote(row.name)} t ORDER BY to_jsonb(t)::text`)).rows;
    return result;
  };

  await t.test('fresh check performs only read-only statements and leaves all data and schema unchanged', async () => {
    await fixture();
    const before = await allRows(), queries = [];
    const wrapper = { query: async (...args) => { queries.push(args[0]); return client.query(...args); } };
    const report = await runMigration(wrapper, { mode: 'check', target: dbTarget, manifest, sql, schema });
    assert.deepEqual(report.blockers, []);
    assert.equal(report.compatibility.counts.pending_accounts, '2');
    assert.ok(report.objects.every(o => o.status === 'pending'));
    assert.equal(queries[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.ok(queries.every(q => /^(BEGIN|SET LOCAL|SELECT|ROLLBACK)/.test(q)));
    assert.deepEqual(await allRows(), before);
  });
  await t.test('guarded apply preserves legacy IDs/data, fills accounts and replays without changing rows', async () => {
    const before = await allRows();
    const report = await run('apply');
    assert.equal(report.applied, true);
    const after = await allRows();
    for (const name of Object.keys(before)) assert.deepEqual(after[name], before[name]);
    assert.equal(after.ysong_account_access.length, 2);
    assert.equal(after.ysong_saas_bootstrap[0].row.user_id, admin);
    const status = await run('status');
    assert.deepEqual(status.blockers, []);
    assert.ok(status.objects.every(o => o.status === 'applied'));
    await run('apply');
    assert.deepEqual(await allRows(), after);
  });
  await t.test('replay preserves reviewed catalog values, NULL prices and stored identity after email reassignment', async () => {
    await client.query("UPDATE users SET email='changed@example.invalid' WHERE id=$1", [admin]);
    await client.query("UPDATE users SET email='psychopathetica@gmail.com' WHERE id=$1", [user]);
    await client.query("UPDATE ysong_plans SET monthly_price_cents=NULL,upgrade_order=42,monthly_generation_quota=7,capabilities='{\"uploads\":true}' WHERE id='basic'");
    const before = await allRows();
    await run('apply');
    assert.deepEqual(await allRows(), before);
  });
  await t.test('missing explicit index is pending; wrong index or missing constraint blocks and never mutates', async () => {
    await client.query('DROP INDEX ysong_generation_owner_history'); // Isolated fixture fault injection only.
    assert.ok((await run('check')).objects.some(o => o.object === 'ysong_generation_owner_history' && o.status === 'pending'));
    await run('apply');
    await client.query('DROP INDEX ysong_generation_owner_history');
    await client.query('CREATE INDEX ysong_generation_owner_history ON ysong_generation_batches(created_at)');
    const before = await allRows();
    assert.match((await run('check')).blockers.join(' '), /Index definition drift/);
    await assert.rejects(run('apply'), /Index definition drift/);
    assert.deepEqual(await allRows(), before);
    await client.query('ALTER TABLE ysong_plans DROP CONSTRAINT ysong_plans_pkey CASCADE');
    assert.match((await run('check')).blockers.join(' '), /Constraint drift/);
  });
  await t.test('missing/duplicate bootstrap email, inactive identity, and identity loss fail closed', async () => {
    await fixture('missing@example.invalid');
    assert.match((await run('check')).blockers.join(' '), /exactly one/);
    await assert.rejects(run('apply'), /exactly one/);
    await client.query("UPDATE users SET email='PSYCHOPATHETICA@gmail.com'");
    await assert.rejects(run('apply'), /exactly one/);
    await fixture();
    await run('apply');
    await client.query("UPDATE ysong_account_access SET account_status='suspended' WHERE user_id=$1", [admin]);
    await assert.rejects(run('apply'), /active stored superadmin/);
    await client.query("UPDATE ysong_account_access SET role='user',account_status='active' WHERE user_id=$1", [admin]);
    await assert.rejects(run('apply'), /no superadmin/);
  });
  await t.test('legacy partial schema and shared World inbox are accepted without changing existing notification rows', async () => {
    await fixture();
    // Use an explicit partial schema from the reviewed SQL, not the current git revision.
    const start = sql.indexOf('CREATE TABLE IF NOT EXISTS ysong_notifications');
    const end = sql.indexOf('ALTER TABLE ysong_plans ADD COLUMN IF NOT EXISTS billing_products');
    await client.query(sql.slice(start, end));
    await client.query("INSERT INTO ysong_notifications(id,user_id,kind,title) VALUES($1,$2,'world','Existing notification')", [crypto.randomUUID(), user]);
    const before = (await allRows()).ysong_notifications;
    await run('apply');
    assert.deepEqual((await allRows()).ysong_notifications, before);
  });
  await t.test('upgrades a previously applied schema while preserving its stored superadmin and catalog', async () => {
    await fixture();
    await run('apply');
    await client.query('DROP TABLE ysong_saas_bootstrap');
    await client.query('ALTER TABLE ysong_plans DROP COLUMN billing_products');
    await client.query('ALTER TABLE ysong_generation_versions DROP COLUMN execution');
    await client.query("DELETE FROM ysong_saas_migrations WHERE id='guarded-migration-v2'");
    await client.query("UPDATE users SET email='changed@example.invalid' WHERE id=$1", [admin]);
    const before = await allRows();
    const check = await run('check');
    assert.deepEqual(check.blockers, []);
    assert.ok(check.objects.some(o => o.object === 'ysong_plans.billing_products' && o.status === 'pending'));
    await run('apply');
    const after = await allRows();
    assert.deepEqual(after.users, before.users);
    assert.deepEqual(after.ysong_account_access, before.ysong_account_access);
    assert.equal(after.ysong_saas_bootstrap[0].row.user_id, admin);
  });
  await t.test('late preservation failure rolls back all schema changes and legacy mutations', async () => {
    await fixture();
    const before = await allRows();
    const wrapper = { query: async (...args) => {
      const result = await client.query(...args);
      if (args[0] === sql) await client.query("UPDATE users SET email='injected-fault@example.invalid' WHERE id=$1", [user]);
      return result;
    } };
    await assert.rejects(runMigration(wrapper, { mode: 'apply', target: dbTarget, manifest, sql, schema }), /preservation verification failed/);
    assert.deepEqual(await allRows(), before);
  });
  await t.test('new users are backfilled on replay without altering existing accounts', async () => {
    await fixture();
    await run('apply');
    const before = (await allRows()).ysong_account_access;
    const added = crypto.randomUUID();
    await client.query("INSERT INTO users VALUES($1,'added@example.invalid')", [added]);
    assert.equal((await run('check')).compatibility.counts.pending_accounts, '1');
    await run('apply');
    const after = (await allRows()).ysong_account_access;
    assert.deepEqual(after.filter(r => r.row.user_id !== added), before);
    const account = after.find(r => r.row.user_id === added).row;
    assert.equal(account.role, 'user'); assert.equal(account.plan_id, 'free');
    assert.equal(account.account_status, 'active'); assert.equal(account.subscription_status, 'none');
  });
  await t.test('server identity mismatch rolls back before migration', async () => {
    await fixture();
    await assert.rejects(runMigration(client, { mode: 'apply', target: { ...dbTarget, databaseName: 'wrong' }, manifest, sql, schema }), /Connected database/);
    assert.equal((await allRows()).ysong_plans, undefined);
  });
  await t.test('concurrent guarded applies serialize and preserve one bootstrap identity', async () => {
    await fixture();
    const other = new pg.Client({ connectionString: url.href });
    await other.connect();
    try {
      const reports = await Promise.all([run('apply'), runMigration(other, { mode: 'apply', target: dbTarget, manifest, sql, schema })]);
      assert.ok(reports.every(r => r.applied));
      assert.equal((await allRows()).ysong_saas_bootstrap.length, 1);
    } finally { await other.end(); }
  });
  await t.test('type drift and pending unique-index data conflicts block read-only preflight', async () => {
    await fixture();
    await run('apply');
    await client.query('DROP INDEX ysong_billing_customer_unique');
    await client.query("UPDATE ysong_account_access SET billing_provider='stripe',billing_live=false,billing_customer_id='cus_duplicate'");
    assert.match((await run('check')).blockers.join(' '), /Duplicate billing customer/);
    await assert.rejects(run('apply'), /Duplicate billing customer/);
    await client.query('ALTER TABLE ysong_plans ALTER COLUMN monthly_price_cents TYPE bigint');
    assert.match((await run('check')).blockers.join(' '), /Column definition drift/);
  });
  await t.test('lost commit acknowledgement reports unknown outcome instead of claiming rollback', async () => {
    await fixture();
    const wrapper = { query: async (...args) => {
      const result = await client.query(...args);
      if (args[0] === 'COMMIT') throw new Error('simulated transport loss');
      return result;
    } };
    await assert.rejects(runMigration(wrapper, { mode: 'apply', target: dbTarget, manifest, sql, schema }), /outcome is unknown/);
    assert.ok((await allRows()).ysong_saas_bootstrap);
    assert.deepEqual((await run('check')).blockers, []);
  });
});
