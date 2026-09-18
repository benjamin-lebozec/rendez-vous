import { DateTime } from 'luxon';
import { WEEKDAYS } from './settings.js';

// Wall-clock time on a given day; "24:00" means midnight at the end of the day.
function at(day, hhmm) {
  if (hhmm === '24:00') return day.plus({ days: 1 }).startOf('day');
  const [hour, minute] = hhmm.split(':').map(Number);
  return day.set({ hour, minute, second: 0, millisecond: 0 });
}

export function rangesForDay(availability, day) {
  const override = availability.overrides.find((o) => o.date === day.toISODate());
  if (override) return override.ranges;
  return availability.weekly[WEEKDAYS[day.weekday - 1]] ?? [];
}

/**
 * Bookable slot start times between `from` and `to`.
 *
 * @param {object} opts
 * @param {object} opts.settings   validated settings
 * @param {{start: string|Date, end: string|Date}[]} opts.busy  busy intervals from all checked calendars
 * @param {Record<string, number>} [opts.bookedPerDay]  bookings already made per local date (for maxPerDay)
 * @param {Date} opts.now
 * @param {Date} opts.from
 * @param {Date} opts.to
 * @returns {string[]} ISO UTC start times
 */
export function computeSlots({ settings, busy, bookedPerDay = {}, now, from, to }) {
  const { availability: av, event } = settings;
  const tz = av.timezone;
  const duration = event.durationMinutes;
  const step = av.slotStepMinutes || duration;
  const bufferMs = av.bufferMinutes * 60_000;

  const earliest = Math.max(
    from.getTime(),
    now.getTime() + av.minNoticeHours * 3_600_000,
  );
  const lastDay = DateTime.fromJSDate(now, { zone: tz }).startOf('day').plus({ days: av.maxDaysAhead });
  const latest = Math.min(to.getTime(), lastDay.plus({ days: 1 }).toMillis());
  if (earliest >= latest) return [];

  const busyMs = busy
    .map((b) => [new Date(b.start).getTime(), new Date(b.end).getTime()])
    .sort((x, y) => x[0] - y[0]);
  const overlapsBusy = (s, e) => busyMs.some(([bs, be]) => bs < e + bufferMs && be > s - bufferMs);

  const slots = [];
  let day = DateTime.fromMillis(earliest, { zone: tz }).startOf('day');
  while (day.toMillis() < latest) {
    const date = day.toISODate();
    const limit = av.maxPerDay > 0 ? av.maxPerDay - (bookedPerDay[date] ?? 0) : Infinity;
    const daySlots = [];

    for (const range of rangesForDay(av, day)) {
      const rangeEnd = at(day, range.end);
      for (let s = at(day, range.start); ; s = s.plus({ minutes: step })) {
        const e = s.plus({ minutes: duration });
        if (e > rangeEnd) break;
        const sMs = s.toMillis();
        if (sMs < earliest || sMs >= latest) continue;
        if (overlapsBusy(sMs, e.toMillis())) continue;
        daySlots.push(s.toUTC().toISO({ suppressMilliseconds: true }));
      }
    }

    if (limit > 0) slots.push(...daySlots);
    day = day.plus({ days: 1 });
  }
  return slots;
}
