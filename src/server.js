import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { DateTime } from 'luxon';
import * as google from './google.js';
import { getSettings, saveSettings } from './settings.js';
import { computeSlots } from './slots.js';
import { appendJsonLine } from './store.js';

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const ADMIN_DIR = path.join(ROOT, 'admin');

const app = express();
app.disable('x-powered-by');
// Number of reverse proxies in front of the app (for the client IP used by rate limiting).
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
  next();
});

// ---------------------------------------------------------------- helpers

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

// Short-lived cache so a visitor browsing months doesn't hammer the Google API.
const slotCache = new Map();
const SLOT_CACHE_MS = 60_000;

async function availableSlots(from, to) {
  const key = `${from.toISOString()}|${to.toISOString()}`;
  const hit = slotCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.slots;

  const settings = getSettings();
  // Widen the query by the buffer so events just outside the window still count.
  const pad = settings.availability.bufferMinutes * 60_000 + 86_400_000;
  const qMin = new Date(from.getTime() - pad);
  const qMax = new Date(to.getTime() + pad);
  const [{ busy, errors }, bookedPerDay] = await Promise.all([
    google.freeBusy(settings, qMin, qMax),
    settings.availability.maxPerDay > 0 ? google.bookedPerDay(settings, qMin, qMax) : {},
  ]);
  if (errors.length) console.warn('[freebusy] agendas illisibles :', errors);

  const slots = computeSlots({ settings, busy, bookedPerDay, now: new Date(), from, to });
  slotCache.set(key, { slots, expires: Date.now() + SLOT_CACHE_MS });
  if (slotCache.size > 200) slotCache.delete(slotCache.keys().next().value);
  return slots;
}

// Serialize bookings so two visitors can't grab the same slot at the same time.
let bookingQueue = Promise.resolve();
function withBookingLock(fn) {
  const run = bookingQueue.then(fn, fn);
  bookingQueue = run.catch(() => {});
  return run;
}

// Each limiter keeps its own counters, so browsing /admin never eats into the booking quota.
const rateLimiters = [];
function rateLimit(max, windowMs) {
  const hitsByIp = new Map();
  rateLimiters.push({ hitsByIp, windowMs });
  return (req, res, next) => {
    const now = Date.now();
    const hits = (hitsByIp.get(req.ip) ?? []).filter((t) => t > now - windowMs);
    if (hits.length >= max) {
      return res.status(429).json({ error: 'Trop de tentatives, réessayez dans quelques minutes.' });
    }
    hits.push(now);
    hitsByIp.set(req.ip, hits);
    next();
  };
}
setInterval(() => {
  for (const { hitsByIp, windowMs } of rateLimiters) {
    const cutoff = Date.now() - windowMs;
    for (const [ip, hits] of hitsByIp) if (!hits.some((t) => t > cutoff)) hitsByIp.delete(ip);
  }
}, 600_000).unref();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[0-9 ().-]{6,25}$/;

function validateGuest(body) {
  const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const guest = {
    firstName: clean(body.firstName, 100),
    lastName: clean(body.lastName, 100),
    email: clean(body.email, 254).toLowerCase(),
    phone: clean(body.phone, 30),
    message: clean(body.message, 2000),
  };
  if (!guest.firstName) throw new HttpError(400, 'Le prénom est obligatoire.');
  if (!guest.lastName) throw new HttpError(400, 'Le nom est obligatoire.');
  if (!EMAIL_RE.test(guest.email)) throw new HttpError(400, 'Adresse e-mail invalide.');
  if (!PHONE_RE.test(guest.phone) || guest.phone.replace(/\D/g, '').length < 6) {
    throw new HttpError(400, 'Numéro de téléphone invalide.');
  }
  return guest;
}

// ---------------------------------------------------------------- public API

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/api/config', (req, res) => {
  const s = getSettings();
  res.json({
    title: s.page.title,
    intro: s.page.intro,
    organizerName: s.page.organizerName,
    durationMinutes: s.event.durationMinutes,
    addMeet: s.event.addMeet,
    timezone: s.availability.timezone,
    maxDaysAhead: s.availability.maxDaysAhead,
    ready: google.connectionStatus().connected,
  });
});

app.get('/api/slots', asyncRoute(async (req, res) => {
  const from = new Date(req.query.from);
  const to = new Date(req.query.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
    throw new HttpError(400, 'Paramètres from/to invalides');
  }
  if (to - from > 45 * 86_400_000) throw new HttpError(400, 'Période trop longue (45 jours max.)');
  res.set('Cache-Control', 'no-store');
  res.json({ slots: await availableSlots(from, to) });
}));

app.post('/api/book', rateLimit(5, 15 * 60_000), asyncRoute(async (req, res) => {
  const body = req.body ?? {};
  // Honeypot field, invisible to humans.
  if (body.website) return res.json({ ok: true });

  const guest = validateGuest(body);
  const start = new Date(body.start);
  if (Number.isNaN(start.getTime())) throw new HttpError(400, 'Créneau invalide.');

  const booking = await withBookingLock(async () => {
    // Re-check against fresh Google data right before creating the event.
    slotCache.clear();
    const settings = getSettings();
    const day = DateTime.fromJSDate(start, { zone: settings.availability.timezone }).startOf('day');
    const slots = await availableSlots(day.toJSDate(), day.plus({ days: 1 }).toJSDate());
    if (!slots.includes(start.toISOString().replace('.000Z', 'Z'))) {
      throw new HttpError(409, 'Ce créneau n’est plus disponible, merci d’en choisir un autre.');
    }
    const created = await google.createBooking(settings, start, guest);
    slotCache.clear();
    return created;
  });

  appendJsonLine('bookings.jsonl', { at: new Date().toISOString(), ...guest, ...booking });
  console.log(`[booking] ${guest.firstName} ${guest.lastName} <${guest.email}> ${booking.start}`);
  res.json({ ok: true, start: booking.start, end: booking.end, meetLink: booking.meetLink });
}));

// ---------------------------------------------------------------- admin

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).send('ADMIN_PASSWORD n’est pas défini : l’administration est désactivée.');
  }
  const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString();
    const sep = decoded.indexOf(':');
    const hash = (v) => crypto.createHash('sha256').update(v).digest();
    const userOk = crypto.timingSafeEqual(hash(decoded.slice(0, sep)), hash(ADMIN_USER));
    const passOk = crypto.timingSafeEqual(hash(decoded.slice(sep + 1)), hash(ADMIN_PASSWORD));
    if (sep > 0 && userOk && passOk) {
      res.set({ 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store' });
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="Rendez-vous admin", charset="UTF-8"');
  res.status(401).send('Authentification requise');
}

// Mutating admin calls must come from our own admin page (blocks CSRF via forms).
function requireAjax(req, res, next) {
  if (req.get('X-Requested-With') !== 'fetch') return res.status(403).json({ error: 'Requête refusée' });
  next();
}

app.use(['/admin', '/api/admin'], requireAdmin, rateLimit(300, 60_000));

app.use('/admin', express.static(ADMIN_DIR, { index: 'index.html' }));

const oauthStates = new Map();
app.get('/admin/oauth/start', (req, res) => {
  if (!google.isConfigured()) return res.status(500).send('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET manquants');
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, Date.now() + 10 * 60_000);
  res.redirect(google.authUrl(state));
});

app.get('/admin/oauth/callback', asyncRoute(async (req, res) => {
  const { state, code, error } = req.query;
  const expires = oauthStates.get(state);
  oauthStates.delete(state);
  if (error) return res.redirect(`/admin?error=${encodeURIComponent(error)}`);
  if (!expires || expires < Date.now() || !code) throw new HttpError(400, 'Session OAuth invalide ou expirée');
  try {
    await google.handleOAuthCallback(code);
  } catch (err) {
    // Admin-only page: show Google's real reason (API disabled, missing scope…).
    console.error('[oauth]', err.cause?.message ?? err.message);
    const reason = err.cause?.message ?? err.response?.data?.error_description ?? err.message;
    return res.redirect(`/admin?error=${encodeURIComponent(reason)}`);
  }
  slotCache.clear();
  res.redirect('/admin?connected=1');
}));

app.get('/api/admin/status', asyncRoute(async (req, res) => {
  const status = google.connectionStatus();
  let calendarErrors = [];
  if (status.connected) {
    try {
      const now = new Date();
      ({ errors: calendarErrors } = await google.freeBusy(getSettings(), now, new Date(now.getTime() + 86_400_000)));
    } catch (err) {
      status.apiError = err.message;
    }
  }
  res.json({ ...status, calendarErrors });
}));

app.get('/api/admin/calendars', asyncRoute(async (req, res) => {
  res.json({ calendars: await google.listCalendars() });
}));

app.get('/api/admin/settings', (req, res) => res.json(getSettings()));

app.put('/api/admin/settings', requireAjax, (req, res) => {
  try {
    const saved = saveSettings(req.body);
    slotCache.clear();
    res.json(saved);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/disconnect', requireAjax, (req, res) => {
  google.disconnect();
  slotCache.clear();
  res.json({ ok: true });
});

// ---------------------------------------------------------------- static + errors

app.use(express.static(PUBLIC_DIR, { index: 'index.html', extensions: ['html'] }));

app.use((err, req, res, next) => {
  // Only show messages we wrote ourselves; Google API errors stay in the logs.
  const status = err.expose ? err.status || 400 : 500;
  if (status >= 500) console.error(err);
  const message = err.expose ? err.message : 'Une erreur est survenue, merci de réessayer plus tard.';
  if (req.path.startsWith('/api/')) return res.status(status).json({ error: message });
  res.status(status).send(message);
});

app.listen(PORT, () => {
  console.log(`Rendez-vous en écoute sur le port ${PORT}`);
  if (!google.isConfigured()) console.warn('⚠ GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET non définis');
  if (!ADMIN_PASSWORD) console.warn('⚠ ADMIN_PASSWORD non défini : /admin désactivé');
});
