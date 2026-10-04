import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));

function integer(value, fallback, minimum, maximum, name) {
  const text = value ?? String(fallback);
  if (!/^\d+$/.test(text)) throw new Error(name + ' must be an integer.');
  const result = Number(text);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new Error(name + ' is outside its supported range.');
  }
  return result;
}

export function readConfig(env = process.env) {
  const email = env.YAHOO_EMAIL?.trim();
  const password = env.YAHOO_APP_PW;
  const token = env.YAHOO_CONNECTOR_TOKEN;
  const key = env.YAHOO_STATE_KEY;
  if (!z.email().safeParse(email).success) throw new Error('Set YAHOO_EMAIL to your Yahoo email address.');
  if (typeof password !== 'string' || !password.trim()) throw new Error('Set YAHOO_APP_PW to a Yahoo app password.');
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    throw new Error('YAHOO_CONNECTOR_TOKEN must contain 32–128 URL-safe characters.');
  }
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(key) ||
      Buffer.from(key, 'base64url').length !== 32 || Buffer.from(key, 'base64url').toString('base64url') !== key) {
    throw new Error('YAHOO_STATE_KEY must be a 32-byte key encoded as unpadded base64url.');
  }
  const readOnly = env.YAHOO_READ_ONLY ?? 'true';
  if (!['true', 'false'].includes(readOnly)) throw new Error('YAHOO_READ_ONLY must be true or false.');
  if (env.YAHOO_STATE_PATH !== undefined && !env.YAHOO_STATE_PATH.trim()) {
    throw new Error('YAHOO_STATE_PATH must not be empty.');
  }
  return {
    email, password, token, key, readOnly: readOnly === 'true',
    port: integer(env.YAHOO_PORT, 8935, 1, 65535, 'YAHOO_PORT'),
    pollInterval: integer(env.YAHOO_POLL_INTERVAL_MS, 60000, 1000, 3600000, 'YAHOO_POLL_INTERVAL_MS'),
    statePath: resolve(projectRoot, env.YAHOO_STATE_PATH ?? 'runtime/state.sqlite'),
  };
}
