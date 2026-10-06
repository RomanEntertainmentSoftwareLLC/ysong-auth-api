import fs from 'node:fs/promises';
import { identifyTarget } from './migration.mjs';

export function parseReleaseArgs(args) {
  const options = { applyMigration: false, applyConfig: false, deploy: false, remote: false, acknowledge: false };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--target' || key === '--config') {
      if (options[key.slice(2)] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Provide one reviewed file for --target and --config.');
      options[key.slice(2)] = args[++i];
    } else if ({ '--apply-migration': 'applyMigration', '--apply-config': 'applyConfig', '--deploy': 'deploy', '--remote': 'remote', '--acknowledge-release': 'acknowledge' }[key]) {
      const field = { '--apply-migration': 'applyMigration', '--apply-config': 'applyConfig', '--deploy': 'deploy', '--remote': 'remote', '--acknowledge-release': 'acknowledge' }[key];
      if (options[field]) throw new Error('Duplicate release option.');
      options[field] = true;
    } else throw new Error('Unknown release option.');
  }
  if (!options.target || !options.config) throw new Error('Provide --target and --config reviewed files.');
  if ((options.applyMigration || options.applyConfig || options.deploy) !== options.acknowledge)
    throw new Error('Mutation flags require --acknowledge-release; acknowledgement requires a mutation flag.');
  if (options.applyConfig && !options.applyMigration) throw new Error('Configuration apply requires --apply-migration in the same run.');
  if (options.deploy && (!options.applyMigration || !options.applyConfig)) throw new Error('Deployment requires migration and configuration apply in the same run.');
  if (options.deploy && !options.remote) throw new Error('Deployment requires --remote final preflight.');
  return options;
}

export async function runRelease(options, { env, root, run, readFile = fs.readFile }) {
  // Never include provider output or exception text in operator logs.
  if (env.SAAS_ENABLED !== '0') throw new Error('SAAS_ENABLED must be explicitly 0.');
  let target;
  try { target = JSON.parse(await readFile(options.target, 'utf8')); }
  catch { throw new Error('Reviewed target JSON cannot be read.'); }
  identifyTarget(env, target);
  const steps = [];
  const execute = async (name, command, args, cwd = root) => {
    steps.push(name);
    const result = await run(command, args, { cwd, env });
    if (result.code !== 0 || (name === 'Clean committed repository' && result.stdout.trim())) throw new Error(`${name} failed; release stopped.`);
  };
  await execute('Clean committed repository', 'git', ['status', '--porcelain', '--untracked-files=normal']);
  await execute('Retired VM workflow', 'node', ['scripts/check-retired-vm.mjs']);
  await execute('Schema status', 'node', ['scripts/migrate-saas.mjs', '--check', '--target', options.target]);
  await execute('Configuration check', 'node', ['scripts/configure-saas.mjs', '--file', options.config, '--check']);
  if (options.applyMigration) await execute('Migration apply', 'node', ['scripts/migrate-saas.mjs', '--apply', '--target', options.target]);
  if (options.applyConfig) await execute('Configuration apply', 'node', ['scripts/configure-saas.mjs', '--file', options.config, '--apply']);
  await execute('Cloudflare build check', 'npm', ['run', 'check'], `${root}/cloudflare`);
  if (options.deploy) await execute('Cloudflare release', 'npm', ['run', 'deploy'], `${root}/cloudflare`);
  await execute('Final preflight', 'node', ['scripts/saas-preflight.mjs', ...(options.remote ? ['--remote'] : [])]);
  return steps;
}
