import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parseReleaseArgs, runRelease } from '../src/saas/release-orchestrator.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = (command, args, options) => new Promise(resolve => {
  const child = spawn(command, args, { ...options, shell: process.platform === 'win32' && command === 'npm', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  // Child output can contain provider diagnostics. Suppress all of it.
  child.stderr.on('data', () => {});
  child.on('error', () => resolve({ code: 1, stdout: '' }));
  child.on('close', code => resolve({ code: code ?? 1, stdout }));
});
try {
  const options = parseReleaseArgs(process.argv.slice(2));
  const steps = await runRelease(options, { env: process.env, root, run });
  for (const step of steps) console.log(`PASS: ${step}`);
  console.log('SaaS remains disabled. Enablement requires a separate explicit owner action.');
} catch (error) {
  console.error(error.message.startsWith('Reviewed') || error.message.includes('release option') || error.message.includes('Provide') || error.message.includes('requires') || error.message.includes('failed; release stopped.') || error.message.includes('SAAS_ENABLED') || error.message.includes('Mutation flags') || error.message.includes('Unknown release option') ? error.message : 'Release gate failed; inspect reviewed target and prerequisites.');
  process.exitCode = 1;
}
