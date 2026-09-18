import { DateTime, IANAZone } from 'luxon';
import { readJson, writeJson } from './store.js';

export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

export const DEFAULT_SETTINGS = {
  page: {
    title: 'Prendre rendez-vous',
    intro: 'Choisissez un créneau qui vous convient. Une invitation avec un lien de visio vous sera envoyée par e-mail.',
    organizerName: '',
    // Empty = public page; otherwise visitors must enter it before booking.
    password: '',
  },
  event: {
    summary: 'Rendez-vous avec {prenom} {nom}',
    description: '',
    durationMinutes: 30,
    addMeet: true,
  },
  availability: {
    timezone: 'Europe/Paris',
    // Start times are generated every `slotStepMinutes` (0 = same as duration).
    slotStepMinutes: 0,
    bufferMinutes: 0,
    minNoticeHours: 4,
    maxDaysAhead: 30,
    maxPerDay: 0,
    weekly: {
      monday: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
      tuesday: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
      wednesday: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
      thursday: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
      friday: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '17:00' }],
      saturday: [],
      sunday: [],
    },
    // { date: 'YYYY-MM-DD', ranges: [] } — empty ranges = day off.
    overrides: [],
  },
  // Your own calendar ("primary") is always checked. Each extra calendar can be
  // checked for conflicts and/or invited to the event.
  calendars: [],
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function int(value, min, max, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} doit être un entier entre ${min} et ${max}`);
  }
  return n;
}

function str(value, max, name) {
  if (value == null) return '';
  if (typeof value !== 'string') throw new Error(`${name} invalide`);
  if (value.length > max) throw new Error(`${name} trop long (max ${max} caractères)`);
  return value.trim();
}

function ranges(list, label) {
  if (!Array.isArray(list)) throw new Error(`Plages invalides pour ${label}`);
  const out = list.map((r) => {
    if (!TIME_RE.test(r?.start) || !TIME_RE.test(r?.end)) {
      throw new Error(`Heure invalide pour ${label} (format HH:MM)`);
    }
    if (r.start >= r.end) throw new Error(`Plage ${r.start}-${r.end} invalide pour ${label}`);
    return { start: r.start, end: r.end };
  });
  out.sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 1; i < out.length; i++) {
    if (out[i].start < out[i - 1].end) throw new Error(`Plages qui se chevauchent pour ${label}`);
  }
  return out;
}

export function validateSettings(input) {
  const s = input ?? {};
  const a = s.availability ?? {};
  if (!IANAZone.isValidZone(a.timezone)) throw new Error('Fuseau horaire invalide');

  const weekly = {};
  for (const day of WEEKDAYS) weekly[day] = ranges(a.weekly?.[day] ?? [], day);

  const seen = new Set();
  const overrides = (a.overrides ?? []).map((o) => {
    if (!DATE_RE.test(o?.date) || !DateTime.fromISO(o.date).isValid) {
      throw new Error('Date d’exception invalide');
    }
    if (seen.has(o.date)) throw new Error(`Exception en double pour le ${o.date}`);
    seen.add(o.date);
    return { date: o.date, ranges: ranges(o.ranges ?? [], o.date) };
  });
  overrides.sort((x, y) => x.date.localeCompare(y.date));

  const calendars = (s.calendars ?? []).map((c) => {
    const id = str(c?.id, 300, 'Identifiant d’agenda');
    if (!id) throw new Error('Identifiant d’agenda vide');
    const invite = Boolean(c.invite);
    if (invite && !EMAIL_RE.test(id)) {
      throw new Error(`« ${id} » doit être une adresse e-mail pour être invité`);
    }
    return { id, label: str(c.label, 100, 'Nom de l’agenda'), checkBusy: Boolean(c.checkBusy), invite };
  });

  return {
    page: {
      title: str(s.page?.title, 150, 'Titre') || DEFAULT_SETTINGS.page.title,
      intro: str(s.page?.intro, 2000, 'Introduction'),
      organizerName: str(s.page?.organizerName, 150, 'Nom affiché'),
      password: str(s.page?.password, 100, 'Mot de passe d’accès'),
    },
    event: {
      summary: str(s.event?.summary, 300, 'Titre de l’événement') || DEFAULT_SETTINGS.event.summary,
      description: str(s.event?.description, 5000, 'Description'),
      durationMinutes: int(s.event?.durationMinutes, 5, 480, 'Durée'),
      addMeet: Boolean(s.event?.addMeet),
    },
    availability: {
      timezone: a.timezone,
      slotStepMinutes: int(a.slotStepMinutes ?? 0, 0, 480, 'Intervalle entre créneaux'),
      bufferMinutes: int(a.bufferMinutes ?? 0, 0, 240, 'Temps tampon'),
      minNoticeHours: int(a.minNoticeHours ?? 0, 0, 24 * 60, 'Délai minimum'),
      maxDaysAhead: int(a.maxDaysAhead ?? 30, 1, 365, 'Réservation max. à l’avance'),
      maxPerDay: int(a.maxPerDay ?? 0, 0, 100, 'Rendez-vous max. par jour'),
      weekly,
      overrides,
    },
    calendars,
  };
}

let cache;

export function getSettings() {
  if (!cache) {
    const saved = readJson('settings.json', null);
    cache = saved ? validateSettings({ ...DEFAULT_SETTINGS, ...saved }) : structuredClone(DEFAULT_SETTINGS);
  }
  return cache;
}

export function saveSettings(input) {
  const valid = validateSettings(input);
  writeJson('settings.json', valid);
  cache = valid;
  return valid;
}
