import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function createConfig(directory = fileURLToPath(new URL('../', import.meta.url))) {
  const template = readFileSync(join(directory, '.env.example'), 'utf8');
  const value = template
    .replace(/^YAHOO_CONNECTOR_TOKEN=$/m, 'YAHOO_CONNECTOR_TOKEN=' + randomBytes(32).toString('base64url'))
    .replace(/^YAHOO_STATE_KEY=$/m, 'YAHOO_STATE_KEY=' + randomBytes(32).toString('base64url'));
  writeFileSync(join(directory, '.env'), value, { flag: 'wx', mode: 0o600 });
}

// pathToFileURL handles drive letters and spaces on Windows.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    createConfig();
    console.log('Created .env with separate random authentication and encryption keys.');
    console.log('Edit YAHOO_EMAIL and YAHOO_APP_PW, then run npm start. Keep .env private.');
  } catch (error) {
    console.error(error.code === 'EEXIST' ? '.env already exists; it was not overwritten.' : 'Configuration could not be created.');
    process.exitCode = 1;
  }
}
