import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, validateSettings } from '../src/settings.js';
import { computeSlots } from '../src/slots.js';

function settingsWith(overrides = {}) {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.availability.minNoticeHours = 0;
  s.availability.weekly = {
    monday: [{ start: '09:00', end: '11:00' }],
    tuesday: [], wednesday: [], thursday: [], friday: [], saturday: [], sunday: [],
  };
  return validateSettings({
    ...s,
    ...overrides,
    event: { ...s.event, ...overrides.event },
    availability: { ...s.availability, ...overrides.availability },
  });
}

// Monday 21 September 2026, Paris is UTC+2.
const MONDAY = new Date('2026-09-21T00:00:00+02:00');
const NEXT_DAY = new Date('2026-09-22T00:00:00+02:00');
const EARLY = new Date('2026-09-20T12:00:00Z');

test('generates slots inside weekly ranges, in the configured timezone', () => {
  const slots = computeSlots({ settings: settingsWith(), busy: [], now: EARLY, from: MONDAY, to: NEXT_DAY });
  assert.deepEqual(slots, [
    '2026-09-21T07:00:00Z', '2026-09-21T07:30:00Z', '2026-09-21T08:00:00Z', '2026-09-21T08:30:00Z',
  ]);
});

test('custom step produces overlapping start times', () => {
  const settings = settingsWith({ event: { durationMinutes: 60 }, availability: { slotStepMinutes: 30 } });
  const slots = computeSlots({ settings, busy: [], now: EARLY, from: MONDAY, to: NEXT_DAY });
  assert.deepEqual(slots, ['2026-09-21T07:00:00Z', '2026-09-21T07:30:00Z', '2026-09-21T08:00:00Z']);
});

test('busy intervals from any calendar remove overlapping slots', () => {
  const busy = [{ start: '2026-09-21T07:15:00Z', end: '2026-09-21T07:45:00Z' }];
  const slots = computeSlots({ settings: settingsWith(), busy, now: EARLY, from: MONDAY, to: NEXT_DAY });
  assert.deepEqual(slots, ['2026-09-21T08:00:00Z', '2026-09-21T08:30:00Z']);
});

test('buffer keeps a margin around busy events', () => {
  const settings = settingsWith({ availability: { bufferMinutes: 15 } });
  const busy = [{ start: '2026-09-21T08:00:00Z', end: '2026-09-21T08:30:00Z' }];
  const slots = computeSlots({ settings, busy, now: EARLY, from: MONDAY, to: NEXT_DAY });
  // 07:30 ends right when the event starts and 08:30 starts right when it ends: both need the buffer.
  assert.deepEqual(slots, ['2026-09-21T07:00:00Z']);
});

test('minimum notice hides slots too close to now', () => {
  const settings = settingsWith({ availability: { minNoticeHours: 1 } });
  const now = new Date('2026-09-21T06:45:00Z');
  const slots = computeSlots({ settings, busy: [], now, from: MONDAY, to: NEXT_DAY });
  assert.deepEqual(slots, ['2026-09-21T08:00:00Z', '2026-09-21T08:30:00Z']);
});

test('date overrides replace the weekly schedule', () => {
  const settings = settingsWith({
    availability: { overrides: [{ date: '2026-09-21', ranges: [{ start: '14:00', end: '15:00' }] }] },
  });
  const slots = computeSlots({ settings, busy: [], now: EARLY, from: MONDAY, to: NEXT_DAY });
  assert.deepEqual(slots, ['2026-09-21T12:00:00Z', '2026-09-21T12:30:00Z']);

  const off = settingsWith({ availability: { overrides: [{ date: '2026-09-21', ranges: [] }] } });
  assert.deepEqual(computeSlots({ settings: off, busy: [], now: EARLY, from: MONDAY, to: NEXT_DAY }), []);
});

test('maxDaysAhead limits the booking horizon', () => {
  const settings = settingsWith({ availability: { maxDaysAhead: 1 } });
  const now = new Date('2026-09-14T12:00:00Z'); // previous Monday
  assert.deepEqual(computeSlots({ settings, busy: [], now, from: MONDAY, to: NEXT_DAY }), []);
});

test('maxPerDay closes a day once the limit is reached', () => {
  const settings = settingsWith({ availability: { maxPerDay: 2 } });
  const args = { settings, busy: [], now: EARLY, from: MONDAY, to: NEXT_DAY };
  assert.equal(computeSlots({ ...args, bookedPerDay: { '2026-09-21': 1 } }).length, 4);
  assert.deepEqual(computeSlots({ ...args, bookedPerDay: { '2026-09-21': 2 } }), []);
});

test('handles DST change days with wall-clock times', () => {
  // Sunday 25 October 2026: Paris switches from UTC+2 to UTC+1.
  const settings = settingsWith({
    availability: { maxDaysAhead: 60, weekly: { ...settingsWith().availability.weekly, sunday: [{ start: '09:00', end: '10:00' }] } },
  });
  const slots = computeSlots({
    settings, busy: [], now: EARLY,
    from: new Date('2026-10-25T00:00:00+02:00'), to: new Date('2026-10-26T00:00:00+01:00'),
  });
  assert.deepEqual(slots, ['2026-10-25T08:00:00Z', '2026-10-25T08:30:00Z']);
});

test('validation rejects overlapping ranges and bad invitees', () => {
  assert.throws(() => settingsWith({
    availability: { weekly: { monday: [{ start: '09:00', end: '12:00' }, { start: '11:00', end: '13:00' }] } },
  }), /chevauchent/);
  assert.throws(() => settingsWith({ calendars: [{ id: 'not-an-email', invite: true }] }), /adresse e-mail/);
});
