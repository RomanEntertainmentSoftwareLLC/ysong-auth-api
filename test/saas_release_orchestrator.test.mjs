import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReleaseArgs, runRelease } from '../src/saas/release-orchestrator.mjs';

const target = { environment: 'production', databaseHost: 'ep-example.us-east-1.aws.neon.tech', databaseName: 'neondb', databaseUser: 'operator', schema: 'public', superadminUserId: '11111111-1111-4111-8111-111111111111' };
const env = { SAAS_ENABLED: '0', DATABASE_URL: 'postgres://operator:password@ep-example.us-east-1.aws.neon.tech/neondb' };
const args = ['--target', 'target.json', '--config', 'config.json'];

test('default is checks only and preserves sequence', async () => {
  const calls = [];
  const steps = await runRelease(parseReleaseArgs(args), { env, root: '/repo', readFile: async () => JSON.stringify(target), run: async (command, argv) => { calls.push([command, argv]); return { code: 0, stdout: '' }; } });
  assert.deepEqual(steps, ['Clean committed repository', 'Retired VM workflow', 'Schema status', 'Configuration check', 'Cloudflare build check', 'Final preflight']);
  assert.equal(calls.some(([, argv]) => argv.includes('--apply') || argv.includes('deploy')), false);
});

test('all mutation flags require acknowledgement and prerequisites', () => {
  assert.throws(() => parseReleaseArgs([...args, '--deploy']), /acknowledge/);
  assert.throws(() => parseReleaseArgs([...args, '--deploy', '--acknowledge-release']), /requires migration/);
  assert.throws(() => parseReleaseArgs([...args, '--apply-config', '--acknowledge-release']), /requires --apply-migration/);
});

test('acknowledged release orders applies before deploy and preflight', async () => {
  const steps = await runRelease(parseReleaseArgs([...args, '--apply-migration', '--apply-config', '--deploy', '--remote', '--acknowledge-release']), { env, root: '/repo', readFile: async () => JSON.stringify(target), run: async () => ({ code: 0, stdout: '' }) });
  assert.deepEqual(steps.slice(4), ['Migration apply', 'Configuration apply', 'Cloudflare build check', 'Cloudflare release', 'Final preflight']);
});

test('dirty tree and failed checks stop later actions', async () => {
  const calls = [];
  await assert.rejects(runRelease(parseReleaseArgs(args), { env, root: '/repo', readFile: async () => JSON.stringify(target), run: async (command) => { calls.push(command); return { code: 0, stdout: ' M file' }; } }), /Clean committed repository failed/);
  assert.deepEqual(calls, ['git']);
  const failures = [];
  await assert.rejects(runRelease(parseReleaseArgs(args), { env, root: '/repo', readFile: async () => JSON.stringify(target), run: async (_, argv) => { failures.push(argv); return { code: argv.includes('scripts/check-retired-vm.mjs') ? 1 : 0, stdout: '' }; } }), /Retired VM workflow failed/);
  assert.equal(failures.some(argv => argv.includes('migrate-saas.mjs')), false);
});

test('target and SaaS flag block before any subprocess', async () => {
  let invoked = false;
  await assert.rejects(runRelease(parseReleaseArgs(args), { env: { ...env, SAAS_ENABLED: '1' }, root: '/repo', readFile: async () => JSON.stringify(target), run: async () => { invoked = true; } }), /SAAS_ENABLED/);
  assert.equal(invoked, false);
});

test('preflight failure preserves failure status', async () => {
  await assert.rejects(runRelease(parseReleaseArgs(args), { env, root: '/repo', readFile: async () => JSON.stringify(target), run: async (_, argv) => ({ code: argv.includes('scripts/saas-preflight.mjs') ? 1 : 0, stdout: '' }) }), /Final preflight failed/);
});
