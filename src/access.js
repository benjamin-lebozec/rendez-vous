import crypto from 'node:crypto';
import { readJson, writeJson } from './store.js';

// Optional password protecting the public booking page. A successful unlock
// sets a cookie holding an HMAC of the current password, so changing the
// password in /admin invalidates every cookie already handed out.

const COOKIE = 'rdv_access';
const MAX_AGE_S = 30 * 86_400;
const SECURE = (process.env.BASE_URL || '').startsWith('https://');

function secret() {
  let saved = readJson('secret.json', null);
  if (!saved?.key) {
    saved = { key: crypto.randomBytes(32).toString('hex') };
    writeJson('secret.json', saved);
  }
  return saved.key;
}
const KEY = secret();

const token = (password) => crypto.createHmac('sha256', KEY).update(password).digest('base64url');

function safeEqual(a, b) {
  const hash = (v) => crypto.createHash('sha256').update(v).digest();
  return crypto.timingSafeEqual(hash(a), hash(b));
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
}

export function isUnlocked(req, password) {
  if (!password) return true;
  return safeEqual(readCookie(req, COOKIE), token(password));
}

/** Checks the submitted password and, if right, sets the access cookie. */
export function unlock(req, res, password) {
  if (!password || !safeEqual(String(req.body?.password ?? '').trim(), password)) return false;
  const attrs = [`${COOKIE}=${token(password)}`, 'Path=/', `Max-Age=${MAX_AGE_S}`, 'HttpOnly', 'SameSite=Lax'];
  if (SECURE) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
  return true;
}
