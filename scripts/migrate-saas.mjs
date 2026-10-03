import 'dotenv/config';
import fs from 'node:fs/promises';
import { pool } from '../src/db.js';
if (!process.argv.includes('--apply')) throw new Error('Review src/saas/schema.sql, then run with --apply against the intended database.');
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('ysong-saas-migration'))");
  await client.query(await fs.readFile(new URL('../src/saas/schema.sql', import.meta.url), 'utf8'));
  await client.query('COMMIT');
  console.log('Additive YSong SaaS migration applied. No prices or quotas were invented.');
} catch { await client.query('ROLLBACK'); throw new Error('SaaS migration failed; transaction rolled back.'); }
finally { client.release(); await pool.end(); }
