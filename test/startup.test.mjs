import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

test('CLI loads an env file and starts from a different directory with spaces', { timeout: 15000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'yahoo startup '));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const token = randomBytes(32).toString('base64url');
  const stateKey = randomBytes(32).toString('base64url');
  const statePath = join(directory, 'state.sqlite');
  const envFile = join(directory, '.env');
  // Node's env parser preserves backslashes in quoted Windows paths.
  const contents = [
    'YAHOO_EMAIL=user@yahoo.com',
    'YAHOO_APP_PW=synthetic-app-password',
    'YAHOO_CONNECTOR_TOKEN=' + token,
    'YAHOO_STATE_KEY=' + stateKey,
    'YAHOO_PORT=' + port,
    'YAHOO_STATE_PATH="' + statePath + '"',
  ].join('\n') + '\n';
  writeFileSync(envFile, contents, { mode: 0o600 });
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('YAHOO_')));
  const child = spawn(process.execPath, ['--env-file=' + envFile, fileURLToPath(new URL('../src/server.mjs', import.meta.url))],
    { cwd: directory, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data.toString(); });
  child.stderr.on('data', data => { output += data.toString(); });
  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', error => resolve({ error }));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    rmSync(directory, { recursive: true, force: true });
  });
  const url = 'http://127.0.0.1:' + port;
  const deadline = Date.now() + 10000;
  while (!output.includes('listening on loopback')) {
    if (child.exitCode !== null || child.signalCode !== null) assert.fail('Server exited during startup: ' + output);
    if (Date.now() >= deadline) assert.fail('Server did not start: ' + output);
    await delay(25);
  }
  const headers = { 'X-Yahoo-Connector-Token': token };
  assert.equal((await fetch(url + '/readyz')).status, 401);
  assert.deepEqual(await (await fetch(url + '/readyz', { headers })).json(), { ready: true });
  const listing = await (await fetch(url + '/mcp', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })).json();
  assert.equal(listing.result.tools.length, 3);
  assert.equal(existsSync(statePath), true);
  assert.equal(output.includes(token), false);
  assert.equal(output.includes(stateKey), false);
});
