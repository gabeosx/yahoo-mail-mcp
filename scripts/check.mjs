import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const directory of ['src', 'scripts', 'test']) {
  for (const name of readdirSync(join(root, directory)).filter(name => name.endsWith('.mjs'))) {
    const result = spawnSync(process.execPath, ['--check', join(root, directory, name)], { stdio: 'inherit' });
    if (result.error || result.status !== 0) process.exit(1);
  }
}
console.log('JavaScript syntax checks passed.');
