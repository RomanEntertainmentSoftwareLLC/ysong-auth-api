// Developer-only manifest generation. Never imports .env or connects to a remote database.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import pg from 'pg';
import { digest, quote, readCatalog } from '../src/saas/migration.mjs';
const url = new URL(process.env.TEST_SAAS_DATABASE_URL);
if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/ysong_saas_validation' || url.search)
  throw new Error('Only the dedicated loopback validation database is allowed.');
const client = new pg.Client({ connectionString: url.href });
await client.connect();
try {
  const schema = `migration_reference_${crypto.randomUUID().replaceAll('-', '')}`;
  await client.query(`CREATE SCHEMA ${quote(schema)}`);
  await client.query(`SET search_path = ${quote(schema)}, pg_catalog`);
  await client.query('CREATE TABLE users(id uuid PRIMARY KEY,email text)');
  await client.query("INSERT INTO users VALUES($1,'psychopathetica@gmail.com')", [crypto.randomUUID()]);
  const sql = await fs.readFile(new URL('../src/saas/schema.sql', import.meta.url), 'utf8');
  await client.query(sql);
  const tables = (await readCatalog(client, schema)).filter(t => t.kind === 'r' && t.name.startsWith('ysong_'));
  await client.query(sql);
  const repeated = (await readCatalog(client, schema)).filter(t => t.kind === 'r' && t.name.startsWith('ysong_'));
  if (JSON.stringify(tables) !== JSON.stringify(repeated)) throw new Error('Schema is not repeat-safe.');
  await fs.writeFile(new URL('../src/saas/schema-manifest.json', import.meta.url), JSON.stringify({ sha256: digest(sql), tables }, null, 2) + '\n');
  console.log('Local reference manifest generated; review SQL and run migration tests before committing. Fixture preserved.');
} finally { await client.end(); }
