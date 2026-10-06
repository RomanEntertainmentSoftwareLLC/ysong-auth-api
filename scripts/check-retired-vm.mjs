import fs from 'node:fs/promises';
const dir = new URL('../.github/workflows/', import.meta.url);
let safe = true;
try {
  const files = (await fs.readdir(dir)).filter(name => /\.ya?ml$/.test(name));
  if (!files.length) safe = false;
  for (const file of files) {
    const source = await fs.readFile(new URL(file, dir), 'utf8');
    if (/VM_SSH_KEY|rsync|systemctl|gcloud|\bssh\b|\bpush\s*:/.test(source)) safe = false;
  }
} catch { safe = false; }
if (!safe) { console.error('Retired VM workflow audit failed.'); process.exitCode = 1; }
else console.log('Retired VM workflow audit passed.');
