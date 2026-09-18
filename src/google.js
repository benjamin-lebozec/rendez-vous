import crypto from 'node:crypto';
import { auth, calendar as calendarApi } from '@googleapis/calendar';
import { DateTime } from 'luxon';
import { readJson, writeJson } from './store.js';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly', // free/busy + calendar list
  'https://www.googleapis.com/auth/calendar.events', // create the booked events
];
const BOOKING_TAG = 'rendezVousBooking';

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
export const REDIRECT_URI = `${BASE_URL}/admin/oauth/callback`;

export const isConfigured = () => Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

function newClient() {
  return new auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);
}

let client;
function authorizedClient() {
  if (client) return client;
  const saved = readJson('google.json', null);
  if (!saved?.tokens?.refresh_token) return null;
  client = newClient();
  client.setCredentials(saved.tokens);
  // Persist refreshed access tokens (Google only sends refresh_token on first consent).
  client.on('tokens', (tokens) => {
    const current = readJson('google.json', {});
    writeJson('google.json', { ...current, tokens: { ...current.tokens, ...tokens } });
  });
  return client;
}

function cal() {
  const c = authorizedClient();
  if (!c) throw Object.assign(new Error('Le service de réservation n’est pas encore configuré.'), { status: 503, expose: true });
  return calendarApi({ version: 'v3', auth: c });
}

export function connectionStatus() {
  const saved = readJson('google.json', null);
  return {
    configured: isConfigured(),
    connected: Boolean(saved?.tokens?.refresh_token),
    email: saved?.email ?? null,
    redirectUri: REDIRECT_URI,
  };
}

export function authUrl(state) {
  return newClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // always return a refresh_token
    scope: SCOPES,
    state,
  });
}

export async function handleOAuthCallback(code) {
  const c = newClient();
  const { tokens } = await c.getToken(code);
  if (!tokens.refresh_token) throw new Error('Google n’a pas renvoyé de refresh token, réessayez.');
  c.setCredentials(tokens);
  const primary = await calendarApi({ version: 'v3', auth: c }).calendarList.get({ calendarId: 'primary' });
  writeJson('google.json', { tokens, email: primary.data.id });
  client = null;
}

export function disconnect() {
  const saved = readJson('google.json', null);
  if (saved?.tokens) newClient().revokeToken(saved.tokens.refresh_token).catch(() => {});
  writeJson('google.json', {});
  client = null;
}

export async function listCalendars() {
  const res = await cal().calendarList.list({ maxResults: 250 });
  return (res.data.items ?? []).map((c) => ({
    id: c.id,
    summary: c.summaryOverride || c.summary,
    accessRole: c.accessRole,
    primary: Boolean(c.primary),
  }));
}

/** Busy intervals of `primary` + every calendar flagged checkBusy. */
export async function freeBusy(settings, timeMin, timeMax) {
  const ids = ['primary', ...settings.calendars.filter((c) => c.checkBusy).map((c) => c.id)];
  const busy = [];
  const errors = [];
  // The API accepts at most 50 calendars per query.
  for (let i = 0; i < ids.length; i += 50) {
    const res = await cal().freebusy.query({
      requestBody: {
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        items: ids.slice(i, i + 50).map((id) => ({ id })),
      },
    });
    for (const [id, info] of Object.entries(res.data.calendars ?? {})) {
      if (info.errors?.length) errors.push({ id, reason: info.errors.map((e) => e.reason).join(', ') });
      busy.push(...(info.busy ?? []));
    }
  }
  return { busy, errors };
}

/** Number of bookings made through this app per local date (only needed for maxPerDay). */
export async function bookedPerDay(settings, timeMin, timeMax) {
  const counts = {};
  let pageToken;
  do {
    const res = await cal().events.list({
      calendarId: 'primary',
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      privateExtendedProperty: [`${BOOKING_TAG}=1`],
      singleEvents: true,
      maxResults: 2500,
      pageToken,
    });
    for (const ev of res.data.items ?? []) {
      if (ev.status === 'cancelled' || !ev.start?.dateTime) continue;
      const date = DateTime.fromISO(ev.start.dateTime).setZone(settings.availability.timezone).toISODate();
      counts[date] = (counts[date] ?? 0) + 1;
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return counts;
}

function fill(template, guest) {
  return template
    .replaceAll('{prenom}', guest.firstName)
    .replaceAll('{nom}', guest.lastName)
    .replaceAll('{email}', guest.email)
    .replaceAll('{telephone}', guest.phone);
}

export async function createBooking(settings, start, guest) {
  const tz = settings.availability.timezone;
  const startDt = DateTime.fromJSDate(start, { zone: tz });
  const endDt = startDt.plus({ minutes: settings.event.durationMinutes });

  const details = [
    `Prénom : ${guest.firstName}`,
    `Nom : ${guest.lastName}`,
    `E-mail : ${guest.email}`,
    `Téléphone : ${guest.phone}`,
    guest.message ? `\nMessage :\n${guest.message}` : '',
  ].filter(Boolean).join('\n');
  const description = [fill(settings.event.description, guest), details].filter(Boolean).join('\n\n');

  const attendees = [
    ...settings.calendars.filter((c) => c.invite).map((c) => ({ email: c.id })),
    { email: guest.email, displayName: `${guest.firstName} ${guest.lastName}` },
  ];

  const res = await cal().events.insert({
    calendarId: 'primary',
    sendUpdates: 'all', // Google e-mails the invitation to every attendee
    conferenceDataVersion: settings.event.addMeet ? 1 : 0,
    requestBody: {
      summary: fill(settings.event.summary, guest),
      description,
      start: { dateTime: startDt.toISO(), timeZone: tz },
      end: { dateTime: endDt.toISO(), timeZone: tz },
      attendees,
      guestsCanModify: false,
      extendedProperties: { private: { [BOOKING_TAG]: '1' } },
      ...(settings.event.addMeet && {
        conferenceData: {
          createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } },
        },
      }),
    },
  });

  return {
    id: res.data.id,
    htmlLink: res.data.htmlLink,
    meetLink: res.data.hangoutLink ?? null,
    start: startDt.toUTC().toISO(),
    end: endDt.toUTC().toISO(),
  };
}
