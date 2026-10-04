import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { readConfig, projectRoot } from '../src/config.mjs';
import { createConfig } from '../scripts/configure.mjs';
import { tunnelOptions } from '../scripts/tunnel.mjs';
import { State } from '../src/state.mjs';
import { createService } from '../src/server.mjs';

const key = () => randomBytes(32).toString('base64url');
const environment = () => ({
  YAHOO_EMAIL: 'user@yahoo.com', YAHOO_APP_PW: 'synthetic-app-password',
  YAHOO_CONNECTOR_TOKEN: key(), YAHOO_STATE_KEY: key(),
});

test('configuration defaults to read-only and uses a stable absolute state path', () => {
  const config = readConfig(environment());
  assert.equal(config.readOnly, true);
  assert.equal(config.port, 8935);
  assert.equal(config.pollInterval, 60000);
  assert.equal(config.statePath, join(projectRoot, 'runtime', 'state.sqlite'));
  assert.equal(isAbsolute(config.statePath), true);
  assert.equal(readConfig({ ...environment(), YAHOO_STATE_PATH: 'custom/data.sqlite' }).statePath,
    join(projectRoot, 'custom', 'data.sqlite'));
  const absolute = join(tmpdir(), 'custom.sqlite');
  assert.equal(readConfig({ ...environment(), YAHOO_STATE_PATH: absolute }).statePath, absolute);
});

test('invalid configuration is rejected without including supplied credentials', () => {
  for (const [name, value] of [
    ['YAHOO_EMAIL', 'private-invalid-email'], ['YAHOO_APP_PW', ''],
    ['YAHOO_STATE_KEY', 'private-invalid-key'], ['YAHOO_CONNECTOR_TOKEN', 'private-invalid-token'],
    ['YAHOO_PORT', '0'], ['YAHOO_PORT', '65536'], ['YAHOO_PORT', '1e3'],
    ['YAHOO_POLL_INTERVAL_MS', '999'], ['YAHOO_READ_ONLY', 'yes'], ['YAHOO_STATE_PATH', ''],
  ]) {
    assert.throws(() => readConfig({ ...environment(), [name]: value }), error => {
      assert.ok(error.message.includes(name));
      if (value.startsWith('private-')) assert.ok(!error.message.includes(value));
      return true;
    });
  }
  assert.equal(readConfig({ ...environment(), YAHOO_READ_ONLY: 'false' }).readOnly, false);
});

test('configuration generator creates independent keys and refuses to replace existing secrets', t => {
  const directory = mkdtempSync(join(tmpdir(), 'yahoo-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const template = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  writeFileSync(join(directory, '.env.example'), template);
  createConfig(directory);
  const content = readFileSync(join(directory, '.env'), 'utf8');
  const token = content.match(/^YAHOO_CONNECTOR_TOKEN=(.+)$/m)[1];
  const stateKey = content.match(/^YAHOO_STATE_KEY=(.+)$/m)[1];
  assert.notEqual(token, stateKey);
  for (const value of [token, stateKey]) assert.equal(Buffer.from(value, 'base64url').length, 32);
  if (process.platform !== 'win32') assert.equal(statSync(join(directory, '.env')).mode & 0o777, 0o600);
  assert.throws(() => createConfig(directory), error => error.code === 'EEXIST');
  assert.equal(readFileSync(join(directory, '.env'), 'utf8'), content);
});

test('tunnel launcher uses environment references for secrets on every platform', () => {
  const env = { ...environment(), CONTROL_PLANE_TUNNEL_ID: 'tunnel_' + 'a'.repeat(32),
    CONTROL_PLANE_API_KEY: 'sk-synthetic-runtime-key', TUNNEL_CLIENT_PATH: join(tmpdir(), 'tools', 'tunnel-client') };
  const options = tunnelOptions(env);
  assert.equal(options.command, env.TUNNEL_CLIENT_PATH);
  assert.equal(options.args.includes(env.CONTROL_PLANE_API_KEY), false);
  assert.equal(options.args.includes(env.YAHOO_CONNECTOR_TOKEN), false);
  assert.ok(options.args.includes('env:CONTROL_PLANE_API_KEY'));
  assert.equal(options.env.MCP_EXTRA_HEADERS, 'X-Yahoo-Connector-Token: env:YAHOO_CONNECTOR_TOKEN');
  assert.equal(options.env.MCP_DISCOVERY_EXTRA_HEADERS, options.env.MCP_EXTRA_HEADERS);
});

test('read-only HTTP mode hides and rejects all write tools', async t => {
  const state = new State(':memory:', key());
  t.after(() => state.db.close());
  let calls = 0;
  const token = key();
  const service = createService({ state, token, mail: { send: async () => { calls++; } } });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => service.server.close(resolve)));
  const rpc = async (method, params = {}) => (await fetch('http://127.0.0.1:' + service.server.address().port + '/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Yahoo-Connector-Token': token },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })).json();
  const listing = await rpc('tools/list');
  assert.deepEqual(listing.result.tools.map(tool => tool.name), ['yahoo_status', 'yahoo_list_messages', 'yahoo_read_message']);
  for (const name of ['yahoo_send_email', 'yahoo_save_draft', 'yahoo_mark_read']) {
    assert.equal((await rpc('tools/call', { name, arguments: {} })).error.code, -32602);
  }
  assert.equal(calls, 0);
});
