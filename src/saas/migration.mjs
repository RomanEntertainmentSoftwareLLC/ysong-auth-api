import crypto from 'node:crypto';

export class MigrationBlocker extends Error {}
const block = message => { throw new MigrationBlocker(message); };
export const quote = name => `"${name.replaceAll('"', '""')}"`;
export const digest = sql => crypto.createHash('sha256').update(sql.replaceAll('\r\n', '\n')).digest('hex');

export function parseArgs(args) {
  let mode = 'check', targetFile;
  if (args.filter(a => ['--check', '--status', '--apply'].includes(a)).length > 1) block('Choose one mode: --check, --status or --apply.');
  for (let i = 0; i < args.length; i++) {
    if (['--check', '--status', '--apply'].includes(args[i])) mode = args[i].slice(2);
    else if (args[i] === '--target' && !targetFile && args[i + 1] && !args[i + 1].startsWith('--')) targetFile = args[++i];
    else block('Unknown or incomplete argument. Use --check|--status|--apply --target reviewed-target.json.');
  }
  return { mode, targetFile };
}

export function identifyTarget(env, target) {
  let url;
  try { url = new URL(env.DATABASE_URL); } catch { block('DATABASE_URL is missing or invalid.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) block('DATABASE_URL must use PostgreSQL.');
  if ([...url.searchParams].some(([k, v]) => k !== 'sslmode' || !['require', 'verify-full'].includes(v)))
    block('Unreviewed connection options; only sslmode=require/verify-full is accepted.');
  if (!/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(url.hostname) || (url.port && url.port !== '5432'))
    block('Production target must be an explicit Neon endpoint on port 5432.');
  let database, user, password;
  try { database = decodeURIComponent(url.pathname.slice(1)); user = decodeURIComponent(url.username); password = decodeURIComponent(url.password); }
  catch { block('Invalid connection identity encoding.'); }
  if (!/^[a-zA-Z0-9_-]+$/.test(database) || !/^[a-zA-Z0-9_-]+$/.test(user)) block('Unsupported database or role identifier.');
  if (!target || target.environment !== 'production' || target.schema !== 'public' || target.databaseHost !== url.hostname || target.databaseName !== database || target.databaseUser !== user)
    block('Reviewed production target must exactly match endpoint, database, role and public schema.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target.superadminUserId || '')) block('Reviewed target must include the immutable superadmin UUID.');
  if (env.SAAS_ENABLED !== '0') block('SAAS_ENABLED must be explicitly 0; verify deployed bindings separately.');
  return { identity: { host: url.hostname, database, schema: 'public', environment: 'production' },
    connection: { host: url.hostname, port: 5432, database, user, password, ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 10000, max: 1 } };
}

export async function readCatalog(client, schema = 'public') {
  const { rows } = await client.query(`SELECT c.relname AS name,c.relkind AS kind,c.relrowsecurity AS rls,c.relpersistence AS persistence,
    EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal) AS triggers,
    EXISTS(SELECT 1 FROM pg_rewrite r WHERE r.ev_class=c.oid AND r.rulename<>'_RETURN') AS rules,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
      'notNull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated) ORDER BY a.attname)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'[]') AS columns,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('name',k.conname,'definition',pg_get_constraintdef(k.oid),'valid',k.convalidated,
      'columns',ARRAY(SELECT a.attname FROM unnest(k.conkey) n JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=n ORDER BY a.attname)) ORDER BY k.conname)
      FROM pg_constraint k WHERE k.conrelid=c.oid),'[]') AS constraints,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('name',ic.relname,'definition',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready) ORDER BY ic.relname)
      FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid),'[]') AS indexes
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 ORDER BY c.relname`, [schema]);
  return rows.map(r => ({ ...r, indexes: r.indexes.map(i => ({ ...i,
    definition: i.definition.replace(` ON ${quote(schema)}.`, ' ON ').replace(` ON ${schema}.`, ' ON ') })) }));
}

export function inspectCatalog(catalog, manifest, sql) {
  if (digest(sql) !== manifest.sha256) block('Schema SQL differs from the reviewed repeat-safe manifest.');
  const objects = [], blockers = [];
  const additions = new Set([...sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+)/g)].map(m => `${m[1]}.${m[2]}`));
  const explicitIndexes = new Set([...sql.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g)].map(m => m[1]));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const expected of manifest.tables) {
    const actual = catalog.find(t => t.name === expected.name);
    objects.push({ object: expected.name, status: actual ? 'applied' : 'pending' });
    if (!actual) {
      for (const i of expected.indexes) if (catalog.some(t => t.name === i.name)) blockers.push(`Index name collision: ${i.name}`);
      continue;
    }
    if (actual.kind !== 'r' || actual.persistence !== 'p' || actual.rls || actual.triggers || actual.rules) blockers.push(`Unsupported relation, RLS, trigger or rule: ${expected.name}`);
    const missing = new Set();
    for (const col of expected.columns) {
      const a = actual.columns.find(c => c.name === col.name), name = `${expected.name}.${col.name}`;
      objects.push({ object: name, status: a ? 'applied' : 'pending' });
      if (!a) { missing.add(col.name); if (!additions.has(name)) blockers.push(`Missing base column: ${name}`); }
      else if (!same(a, col)) blockers.push(`Column definition drift: ${name}`);
    }
    if (actual.columns.some(c => !expected.columns.some(e => e.name === c.name))) blockers.push(`Unexpected columns: ${expected.name}`);
    for (const c of expected.constraints) {
      const a = actual.constraints.find(x => x.name === c.name);
      if (!a && c.columns.some(x => missing.has(x))) continue;
      if (!a || !same(a, c)) blockers.push(`Constraint drift: ${expected.name}.${c.name}`);
    }
    if (actual.constraints.some(c => !expected.constraints.some(e => e.name === c.name))) blockers.push(`Unexpected constraints: ${expected.name}`);
    for (const i of expected.indexes) {
      const a = actual.indexes.find(x => x.name === i.name);
      objects.push({ object: i.name, status: a ? 'applied' : 'pending' });
      if (a && !same(a, i)) blockers.push(`Index definition drift: ${i.name}`);
      if (!a && (!explicitIndexes.has(i.name) || catalog.some(t => t.name === i.name))) blockers.push(`Missing constraint index or name collision: ${i.name}`);
    }
    if (actual.indexes.some(i => !expected.indexes.some(e => e.name === i.name))) blockers.push(`Unexpected indexes: ${expected.name}`);
  }
  const users = catalog.find(t => t.name === 'users');
  if (!users || users.kind !== 'r' || users.rls || !users.columns.some(c => c.name === 'id' && c.type === 'uuid' && c.notNull) ||
    !users.columns.some(c => c.name === 'email' && ['text', 'citext', 'character varying'].includes(c.type)) ||
    !users.constraints.some(c => c.definition === 'PRIMARY KEY (id)' && c.valid)) blockers.push('users must have a visible UUID primary key and compatible email column.');
  return { objects, blockers };
}

export async function inspectData(client, catalog, target, schema = 'public') {
  const has = name => catalog.some(t => t.name === name && t.kind === 'r');
  const table = name => `${quote(schema)}.${quote(name)}`;
  const blockers = [];
  let superadmin, bootstrap = 'pending';
  if (has('ysong_account_access')) {
    const { rows } = await client.query(`SELECT user_id,account_status FROM ${table('ysong_account_access')} WHERE role='superadmin'`);
    if (rows.length > 1 || (rows.length === 1 && rows[0].account_status !== 'active')) blockers.push('Exactly one active stored superadmin is required.');
    if (rows.length === 1) superadmin = rows[0].user_id;
  }
  if (!superadmin) {
    if (has('ysong_saas_migrations') || has('ysong_saas_bootstrap')) blockers.push('Existing migration/bootstrap state has no superadmin; manual review required.');
    const { rows } = await client.query(`SELECT id FROM ${table('users')} WHERE lower(email::text)=$1`, ['psychopathetica@gmail.com']);
    if (rows.length !== 1) blockers.push('Bootstrap email must resolve to exactly one existing user.');
    else superadmin = rows[0].id;
  }
  if (superadmin !== target.superadminUserId) blockers.push('Resolved superadmin does not match reviewed immutable UUID.');
  if (superadmin && has('ysong_account_access')) {
    const { rows } = await client.query(`SELECT 1 FROM ${table('ysong_account_access')} WHERE user_id=$1 AND account_status<>'active'`, [superadmin]);
    if (rows.length) blockers.push('Bootstrap/stored superadmin account must be active.');
    const duplicates = await client.query(`SELECT 1 FROM ${table('ysong_account_access')}
      WHERE billing_customer_id IS NOT NULL AND billing_provider IS NOT NULL AND billing_live IS NOT NULL
      GROUP BY billing_provider,billing_live,billing_customer_id HAVING count(*)>1 LIMIT 1`);
    if (duplicates.rows.length) blockers.push('Duplicate billing customer mapping prevents the unique index.');
  }
  if (has('ysong_policy_versions')) {
    const { rows } = await client.query(`SELECT 1 FROM ${table('ysong_policy_versions')} WHERE active GROUP BY policy_id HAVING count(*)>1 LIMIT 1`);
    if (rows.length) blockers.push('Multiple active versions of one policy prevent the unique index.');
  }
  if (has('ysong_saas_bootstrap')) {
    const { rows } = await client.query(`SELECT id,user_id FROM ${table('ysong_saas_bootstrap')}`);
    if (rows.length !== 1 || rows[0].id !== 'superadmin' || rows[0].user_id !== superadmin) blockers.push('Immutable bootstrap identity mismatch.');
    else bootstrap = 'applied';
  }
  const { rows: [counts] } = await client.query(`SELECT count(*)::text AS users,
    ${has('ysong_account_access') ? `(SELECT count(*) FROM ${table('users')} u LEFT JOIN ${table('ysong_account_access')} a ON a.user_id=u.id WHERE a.user_id IS NULL)` : 'count(*)'}::text AS pending_accounts FROM ${table('users')}`);
  const plans = has('ysong_plans') ? (await client.query(`SELECT id FROM ${table('ysong_plans')} ORDER BY id`)).rows.map(r => r.id) : [];
  if (plans.some(id => !['free', 'basic', 'pro', 'premium'].includes(id))) blockers.push('Unexpected plan IDs; manual catalog review required.');
  const markers = has('ysong_saas_migrations') ? (await client.query(`SELECT id FROM ${table('ysong_saas_migrations')} ORDER BY id`)).rows.map(r => r.id) : [];
  const expectedMarkers = ['launch-preparation-v1', 'guarded-migration-v2'];
  if (markers.some(id => !expectedMarkers.includes(id))) blockers.push('Unknown migration marker; review migration version before applying.');
  return { blockers, counts, bootstrap, plans: ['free', 'basic', 'pro', 'premium'].map(id => ({ id, status: plans.includes(id) ? 'applied' : 'pending' })),
    markers: expectedMarkers.map(id => ({ id, status: markers.includes(id) ? 'applied' : 'pending' })) };
}

// Internal preservation evidence under locks; never log row contents or fingerprints.
export async function legacySnapshot(client, catalog, manifest, schema = 'public') {
  const result = {};
  for (const t of catalog.filter(t => t.kind === 'r' && (t.name === 'ysong_notifications' || !manifest.tables.some(e => e.name === t.name)))) {
    if (t.rls) block('Legacy row-level security prevents complete preservation verification.');
    result[t.name] = (await client.query(`SELECT count(*)::text AS count,COALESCE(sum(hashtextextended(to_jsonb(t)::text,0)::numeric),0)::text AS fingerprint FROM ${quote(schema)}.${quote(t.name)} t`)).rows[0];
  }
  return result;
}

export async function runMigration(client, { mode, target, manifest, sql, schema = 'public' }) {
  const apply = mode === 'apply';
  await client.query(apply ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query(`SET LOCAL search_path = ${quote(schema)}, pg_catalog`);
    const { rows: [server] } = await client.query('SELECT current_database() AS database,current_user AS role,current_schema() AS schema,pg_is_in_recovery() AS replica');
    if (server.database !== target.databaseName || server.role !== target.databaseUser || server.schema !== schema || server.replica) block('Connected database/role/schema differs from reviewed target or is a replica.');
    if (apply) await client.query("SELECT pg_advisory_xact_lock(hashtext('ysong-saas-migration'))");
    let catalog = await readCatalog(client, schema);
    const { rows: eventTriggers } = await client.query("SELECT 1 FROM pg_event_trigger WHERE evtenabled <> 'D' LIMIT 1");
    if (apply) {
      const tables = catalog.filter(t => t.kind === 'r').map(t => `${quote(schema)}.${quote(t.name)}`);
      if (tables.length) await client.query(`LOCK TABLE ${tables.join(',')} IN SHARE ROW EXCLUSIVE MODE`);
      catalog = await readCatalog(client, schema);
    }
    const report = inspectCatalog(catalog, manifest, sql);
    if (eventTriggers.length) report.blockers.push('Enabled database event triggers require manual review before migration.');
    if (catalog.some(t => ['r', 'p'].includes(t.kind) && t.rls)) report.blockers.push('Row-level security prevents complete compatibility/preservation verification.');
    if (!report.blockers.length) report.compatibility = await inspectData(client, catalog, target, schema);
    report.blockers.push(...(report.compatibility?.blockers || []));
    report.legacyTables = catalog.filter(t => t.kind === 'r' && !manifest.tables.some(e => e.name === t.name)).map(t => t.name);
    if (apply && report.blockers.length) block(report.blockers.join(' '));
    if (apply) {
      const before = await legacySnapshot(client, catalog, manifest, schema);
      await client.query(sql);
      const afterCatalog = await readCatalog(client, schema), after = inspectCatalog(afterCatalog, manifest, sql);
      const data = await inspectData(client, afterCatalog, target, schema);
      if (after.blockers.length || after.objects.some(o => o.status !== 'applied') || data.blockers.length || data.counts.pending_accounts !== '0' || data.markers.some(m => m.status !== 'applied')) block('Post-apply schema/account verification failed; transaction rolled back.');
      if (JSON.stringify(before) !== JSON.stringify(await legacySnapshot(client, catalog, manifest, schema))) block('Legacy data preservation verification failed; transaction rolled back.');
      try { await client.query('COMMIT'); }
      catch { block('Commit acknowledgement failed; outcome is unknown. Run a read-only check and inspect database state before retrying.'); }
      return { ...after, compatibility: data, applied: true, preservedLegacyTables: Object.keys(before) };
    }
    await client.query('ROLLBACK');
    return { ...report, applied: false };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
}
