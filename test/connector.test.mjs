import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Webhook } from 'standardwebhooks';
import { State } from '../src/state.mjs';
import { MailEvents, eventDefinition, publicAddress, webhookHeaders, webhookRequest } from '../src/events.mjs';
import { createService } from '../src/server.mjs';

const key = () => randomBytes(32).toString('base64url');
const secret = () => `whsec_${randomBytes(32).toString('base64')}`;
const memory = t => { const state = new State(':memory:', key()); t.after(() => state.db.close()); return state; };
const subscription = () => ({ name: eventDefinition.name, arguments: {}, delivery: { mode: 'webhook', url: 'https://receiver.example/callback', secret: secret() }, cursor: null });
const metadata = uid => ({ uid, uidValidity: '1', messageId: `<${uid}@example.com>`, subject: 'Hello', from: [{ name: 'Sender', address: 'sender@example.com' }], date: new Date().toISOString() });
const echo = async (_url, headers, body) => {
  const parsed = JSON.parse(body);
  assert.ok(headers['webhook-signature']);
  return { status: 200, body: JSON.stringify({ challenge: parsed.challenge }) };
};

test('durable write IDs suppress duplicate sends, reject changed content, and keep results encrypted', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'yahoo-test-'));
  const encryptionKey = key(); const path = join(directory, 'state.sqlite');
  let state = new State(path, encryptionKey); let calls = 0;
  t.after(() => { state.db.close(); rmSync(directory, { recursive: true, force: true }); });
  const action = async () => { calls++; return { accepted: ['private-recipient@example.com'] }; };
  const first = await state.writeOnce('send', 'request', { text: 'Message', to: 'Recipient' }, action);
  state.db.close(); state = new State(path, encryptionKey);
  assert.deepEqual(await state.writeOnce('send', 'request', { to: 'Recipient', text: 'Message' }, action), first);
  await assert.rejects(() => state.writeOnce('send', 'request', { text: 'Changed' }, action), /collision/);
  assert.equal(calls, 1);
  assert.equal(readFileSync(path).includes(Buffer.from('private-recipient@example.com')), false);
});

test('failed or concurrently pending writes cannot be silently repeated', async t => {
  const state = memory(t); let calls = 0;
  const action = async () => { calls++; throw new Error('SMTP disconnected after write'); };
  await assert.rejects(() => state.writeOnce('send', 'first', {}, action));
  await assert.rejects(() => state.writeOnce('send', 'first', {}, action), /Uncertain/);
  let finish;
  const pending = state.writeOnce('send', 'second', {}, () => new Promise(resolve => { finish = resolve; }));
  await assert.rejects(() => state.writeOnce('send', 'second', {}, action), /Uncertain/);
  finish({ accepted: true }); await pending;
  assert.equal(calls, 1);
});

test('webhook signatures cover exact bytes and support secret rotation', () => {
  const current = secret(), previous = secret();
  const body = JSON.stringify({ eventId: 'event', data: 'Hello' });
  const headers = webhookHeaders({ id: 'sub', secret: current, oldSecret: previous, oldSecretUntil: Date.now() + 30000 }, 'event', body);
  assert.deepEqual(new Webhook(current).verify(body, headers), JSON.parse(body));
  assert.deepEqual(new Webhook(previous).verify(body, headers), JSON.parse(body));
  assert.throws(() => new Webhook(current).verify(body + ' ', headers));
});

test('callback validation rejects private DNS, mixed DNS, non-HTTPS, and credentials before connecting', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fc00::1', '::ffff:127.0.0.1', '224.0.0.1']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('1.1.1.1'), true);
  for (const url of ['http://receiver.example', 'https://user:pass@receiver.example', 'https://receiver.example:8443', 'https://receiver.example/#fragment']) await assert.rejects(() => webhookRequest(url, {}, '{}'), /Invalid/);
  await assert.rejects(() => webhookRequest('https://receiver.example', {}, '{}', async () => [{ address: '127.0.0.1', family: 4 }]), /public/);
  await assert.rejects(() => webhookRequest('https://receiver.example', {}, '{}', async () => [{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }]), /public/);
});

test('subscriptions refresh in place, cache verification, preserve cursor, and isolate owners', async t => {
  const state = memory(t); let checks = 0;
  const events = new MailEvents({ mailboxState: async () => ({ uidValidity: '1', lastUid: 10 }) }, state, async (...args) => { checks++; return echo(...args); });
  const input = subscription();
  const first = await events.subscribe('owner', input);
  state.checkpoint(first.id, '1', 12, []);
  const renewed = await events.subscribe('owner', { ...input, arguments: { mailbox: 'INBOX' } });
  assert.equal(renewed.id, first.id); assert.equal(checks, 1); assert.equal(state.getSubscription(first.id).lastUid, 12);
  events.unsubscribe('someone-else', input); assert.ok(state.getSubscription(first.id));
  const oldSecret = input.delivery.secret; input.delivery.secret = secret();
  await events.subscribe('owner', input);
  assert.equal(state.getSubscription(first.id).oldSecret, oldSecret); assert.equal(checks, 2);
  events.unsubscribe('owner', input); events.unsubscribe('owner', input); assert.equal(state.subscriptions().length, 0);
});

test('failed callback verification stores no subscription', async t => {
  const state = memory(t);
  const events = new MailEvents({}, state, async () => ({ status: 200, body: '{"challenge":"wrong"}' }));
  await assert.rejects(() => events.subscribe('owner', subscription()), error => error.rpcCode === -32015);
  assert.equal(state.subscriptions().length, 0);
});

test('new matching mail queues durable events; retry keeps event ID and never repeats old messages', async t => {
  const state = memory(t); let lastUid = 10; let status = 503; const received = [];
  const mail = { mailboxState: async () => ({ uidValidity: '1', lastUid }), list: async () => ({ uidValidity: '1', messages: [metadata(11), { ...metadata(12), subject: 'Excluded' }] }) };
  const events = new MailEvents(mail, state, async (url, headers, body) => {
    const value = JSON.parse(body);
    if (value.type === 'verification') return echo(url, headers, body);
    received.push(value); assert.equal(headers['webhook-id'], value.eventId);
    return { status, body: '' };
  });
  const input = subscription(); input.arguments = { subject: 'Hello' };
  const subscribed = await events.subscribe('owner', input);
  lastUid = 12; await events.tick();
  assert.equal(received.length, 1); assert.equal(state.getSubscription(subscribed.id).lastUid, 12);
  assert.equal(state.db.prepare('SELECT attempts FROM outbox').get().attempts, 1);
  state.db.prepare('UPDATE outbox SET due=0').run(); status = 200; await events.tick();
  assert.equal(received[0].eventId, received[1].eventId); assert.equal(state.dueEvents().length, 0);
  await events.tick(); assert.equal(received.length, 2);
});

test('mailbox rebuilds and expired subscriptions stop stale delivery', async t => {
  const state = memory(t); let validity = '1'; let lastUid = 10; let sends = 0;
  const mail = { mailboxState: async () => ({ uidValidity: validity, lastUid }), list: async () => ({ uidValidity: '2', messages: [metadata(11)] }) };
  const events = new MailEvents(mail, state, async (...args) => { sends++; return echo(...args); });
  const input = subscription(); const sub = await events.subscribe('owner', input);
  lastUid = 11; await events.tick(); assert.equal(sends, 1); // UID validity changed between snapshot and list.
  validity = '2'; lastUid = 20; await events.tick(); assert.equal(sends, 1);
  state.putSubscription({ ...state.getSubscription(sub.id), expires: 0 });
  await events.tick(); assert.equal(state.subscriptions().length, 0);
});

test('authenticated HTTP discovery works; unauthorized requests and header injection cannot call mail', async t => {
  const state = memory(t); const token = key(); let calls = 0;
  const service = createService({ state, token, readOnly: false, mail: { status: async () => { calls++; return { authenticated: true }; }, send: async () => { calls++; return {}; } } });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => service.server.close(resolve)));
  const url = `http://127.0.0.1:${service.server.address().port}/mcp`;
  const rpc = async (method, params = {}, auth = token) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Yahoo-Connector-Token': auth }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  assert.equal((await rpc('tools/call', { name: 'yahoo_status' }, 'wrong')).status, 401); assert.equal(calls, 0);
  const discovery = await (await rpc('server/discover')).json(); assert.deepEqual(discovery.result.capabilities, { tools: {}, events: {} });
  const definitions = await (await rpc('tools/list')).json(); assert.equal(definitions.result.tools.length, 6);
  const bad = await (await rpc('tools/call', { name: 'yahoo_send_email', arguments: { requestId: randomUUID(), to: ['recipient@example.com'], subject: 'Hello\r\nBcc: attacker@example.com', text: 'Hello' } })).json();
  assert.equal(bad.result.isError, true); assert.equal(calls, 0);
  assert.equal((await (await rpc('tools/call', { name: 'yahoo_status' })).json()).result.structuredContent.authenticated, true); assert.equal(calls, 1);
});
