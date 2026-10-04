import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(value).digest('hex');

export class State {
  constructor(path, encryptionKey) {
    if (typeof encryptionKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(encryptionKey) || Buffer.from(encryptionKey, 'base64url').toString('base64url') !== encryptionKey) throw new Error('A canonical base64url state encryption key is required.');
    this.key = Buffer.from(encryptionKey, 'base64url');
    if (this.key.length !== 32) throw new Error('A 32-byte state encryption key is required.');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:' && process.platform !== 'win32') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=DELETE;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS writes (id TEXT PRIMARY KEY, hash TEXT NOT NULL, status TEXT NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, data TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL);
    `);
  }

  encrypt(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  }
  decrypt(value) {
    const bytes = Buffer.from(value, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'));
  }

  async writeOnce(operation, id, input, action) {
    const key = `${operation}:${id}`;
    const hash = digest(canonical(input));
    const previous = this.db.prepare('SELECT * FROM writes WHERE id=?').get(key);
    if (previous) {
      if (previous.hash !== hash) throw Object.assign(new Error('Request ID collision'), { safeMessage: 'This requestId was already used with different content.' });
      if (previous.status === 'done') return this.decrypt(previous.result);
      throw Object.assign(new Error('Uncertain write'), { safeMessage: 'The earlier write has an uncertain outcome. Check Yahoo before retrying with a new requestId.' });
    }
    this.db.prepare('INSERT INTO writes(id,hash,status) VALUES(?,?,?)').run(key, hash, 'pending');
    try {
      const result = await action();
      this.db.prepare('UPDATE writes SET status=?,result=? WHERE id=?').run('done', this.encrypt(result), key);
      return result;
    } catch (error) {
      this.db.prepare('UPDATE writes SET status=? WHERE id=?').run('uncertain', key);
      throw error;
    }
  }

  getSubscription(id) {
    const row = this.db.prepare('SELECT data FROM subscriptions WHERE id=?').get(id);
    return row ? this.decrypt(row.data) : null;
  }
  putSubscription(subscription) {
    this.db.prepare('INSERT INTO subscriptions(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(subscription.id, this.encrypt(subscription));
  }
  subscriptions() {
    return this.db.prepare('SELECT data FROM subscriptions').all().map(row => this.decrypt(row.data));
  }
  removeSubscription(id) {
    this.db.prepare('DELETE FROM subscriptions WHERE id=?').run(id);
    this.db.prepare('DELETE FROM outbox WHERE subscription_id=?').run(id);
  }
  checkpoint(id, uidValidity, lastUid, events) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const subscription = this.getSubscription(id);
      if (subscription) {
        for (const event of events) this.db.prepare('INSERT OR IGNORE INTO outbox(id,subscription_id,data,due) VALUES(?,?,?,?)').run(event.eventId, id, this.encrypt(event), Date.now());
        this.putSubscription({ ...subscription, uidValidity, lastUid });
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  dueEvents() {
    return this.db.prepare('SELECT * FROM outbox WHERE due<=? ORDER BY due LIMIT 100').all(Date.now()).map(row => ({ ...row, event: this.decrypt(row.data) }));
  }
  finishEvent(id) { this.db.prepare('DELETE FROM outbox WHERE id=?').run(id); }
  retryEvent(row) {
    if (row.attempts >= 7) return this.finishEvent(row.id);
    const delay = Math.min(60_000 * 2 ** row.attempts, 3_600_000);
    this.db.prepare('UPDATE outbox SET attempts=attempts+1,due=? WHERE id=?').run(Date.now() + delay, row.id);
  }
}
