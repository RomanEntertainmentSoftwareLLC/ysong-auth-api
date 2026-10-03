import 'dotenv/config';
import fs from 'node:fs/promises';
import pg from 'pg';
import { identifyTarget, parseArgs, runMigration, MigrationBlocker } from '../src/saas/migration.mjs';

let pool, client;
try {
  const { mode, targetFile } = parseArgs(process.argv.slice(2));
  if (!targetFile) throw new MigrationBlocker('Provide --target with independently reviewed production endpoint, database, role, public schema and superadmin UUID; no connection attempted.');
  let target;
  try { target = JSON.parse(await fs.readFile(targetFile, 'utf8')); }
  catch { throw new MigrationBlocker('Cannot read reviewed target JSON.'); }
  const { identity, connection } = identifyTarget(process.env, target);
  console.log(JSON.stringify({ mode, target: identity, tls: 'verify-full', saasEnabled: false }));
  const sql = await fs.readFile(new URL('../src/saas/schema.sql', import.meta.url), 'utf8');
  const manifest = JSON.parse(await fs.readFile(new URL('../src/saas/schema-manifest.json', import.meta.url), 'utf8'));
  pool = new pg.Pool(connection);
  client = await pool.connect();
  const report = await runMigration(client, { mode, target, manifest, sql });
  console.log(JSON.stringify(report, null, 2));
  if (report.blockers.length) process.exitCode = 1;
} catch (error) {
  // Driver messages can contain credentials, SQL or user data. Never print them.
  const reason = {
    '42501': 'Insufficient database permissions.', '55P03': 'Lock unavailable; drain writers and retry in an approved maintenance window.',
    '57014': 'Statement timeout; inspect database size/load before retrying.', '23505': 'Existing data violates a required unique key.',
    '23503': 'Existing data violates a required foreign key.', '42P01': 'A required relation is missing.',
    '42703': 'A required column is missing.', '28P01': 'Database authentication failed.',
    'P0001': 'Superadmin bootstrap invariant failed.',
  }[error.code] || 'Inspect connectivity, permissions or schema offline.';
  console.error(error instanceof MigrationBlocker ? `BLOCKER: ${error.message}` :
    `BLOCKER: Database/file operation failed${/^[0-9A-Z]{5}$/.test(error.code || '') ? ` (SQLSTATE ${error.code})` : ''}; no apply committed. ${reason}`);
  process.exitCode = 1;
} finally {
  client?.release();
  await pool?.end();
}
