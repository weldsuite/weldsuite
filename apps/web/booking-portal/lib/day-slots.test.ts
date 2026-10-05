import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BusyEvent } from './availability.ts';
import {
  computeDaySlots,
  dateInTimezone,
  isCalendarDate,
  isSlotStillAvailable,
  type DaySlotsPage,
  type DaySlotsSource,
} from './day-slots.ts';

// Monday 2026-05-04, in Amsterdam (UTC+2 in May) and in UTC.
const NOW = new Date('2026-05-01T00:00:00Z');

const page = (over: Partial<DaySlotsPage> = {}): DaySlotsPage => ({
  timezone: 'UTC',
  weekly: { monday: [{ start: '09:00', end: '11:00' }] },
  overrides: null,
  durationMinutes: 30,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  minNoticeMinutes: 60,
  maxAdvanceDays: 60,
  maxBookingsPerDay: null,
  ...over,
});

interface SourceCalls {
  busy: Array<[Date, Date]>;
  counts: Array<[Date, Date]>;
}

function source(busy: BusyEvent[] = [], bookings = 0): DaySlotsSource & { calls: SourceCalls } {
  const calls: SourceCalls = { busy: [], counts: [] };
  return {
    calls,
    busyEvents: async (from, to) => {
      calls.busy.push([from, to]);
      return busy;
    },
    bookingCount: async (from, to) => {
      calls.counts.push([from, to]);
      return bookings;
    },
  };
}

const availableStarts = (slots: Awaited<ReturnType<typeof computeDaySlots>>) =>
  slots.filter((s) => s.available).map((s) => s.start.slice(11, 16));

describe('isCalendarDate / dateInTimezone', () => {
  it('accepts only real YYYY-MM-DD dates', () => {
    assert.equal(isCalendarDate('2026-05-04'), true);
    assert.equal(isCalendarDate('2026-5-4'), false);
    assert.equal(isCalendarDate('2026-05-04T10:00'), false);
    assert.equal(isCalendarDate('nope'), false);
  });

  it('reads the date of an instant in the page timezone, not in UTC', () => {
    // 22:30Z on the 3rd is already the 4th in Amsterdam.
    assert.equal(dateInTimezone(new Date('2026-05-03T22:30:00Z'), 'Europe/Amsterdam'), '2026-05-04');
    assert.equal(dateInTimezone(new Date('2026-05-03T22:30:00Z'), 'UTC'), '2026-05-03');
  });
});

describe('computeDaySlots', () => {
  it('lists the weekday ranges as slots in the page timezone', async () => {
    const slots = await computeDaySlots(
      page({ timezone: 'Europe/Amsterdam' }),
      '2026-05-04',
      source(),
      NOW,
    );
    // 09:00 Amsterdam is 07:00Z in May.
    assert.deepEqual(availableStarts(slots), ['07:00', '07:30', '08:00', '08:30']);
  });

  it('offers nothing on a day without ranges and does not query', async () => {
    const src = source();
    assert.deepEqual(await computeDaySlots(page(), '2026-05-05', src, NOW), []);
    assert.equal(src.calls.busy.length, 0);
  });

  it('lets a date override replace the weekly ranges, or close the day', async () => {
    const opened = await computeDaySlots(
      page({ overrides: [{ date: '2026-05-04', slots: [{ start: '14:00', end: '15:00' }] }] }),
      '2026-05-04',
      source(),
      NOW,
    );
    assert.deepEqual(availableStarts(opened), ['14:00', '14:30']);

    const closed = await computeDaySlots(
      page({ overrides: [{ date: '2026-05-04', slots: [] }] }),
      '2026-05-04',
      source(),
      NOW,
    );
    assert.deepEqual(closed, []);
  });

  it('offers nothing beyond max advance', async () => {
    const far = '2026-05-11'; // 10 days after NOW
    assert.deepEqual(await computeDaySlots(page({ maxAdvanceDays: 5 }), far, source(), NOW), []);
    assert.ok((await computeDaySlots(page({ maxAdvanceDays: 10 }), far, source(), NOW)).length > 0);
  });

  it('blocks slots that overlap events, tentative included, and ignores cancelled', async () => {
    const slots = await computeDaySlots(
      page(),
      '2026-05-04',
      source([
        { startTime: '2026-05-04T09:00:00Z', endTime: '2026-05-04T09:30:00Z', status: 'confirmed' },
        { startTime: '2026-05-04T09:30:00Z', endTime: '2026-05-04T10:00:00Z', status: 'tentative' },
        { startTime: '2026-05-04T10:00:00Z', endTime: '2026-05-04T10:30:00Z', status: 'cancelled' },
      ]),
      NOW,
    );
    assert.deepEqual(availableStarts(slots), ['10:00', '10:30']);
  });

  it('is blocked by a multi-day event that started on an earlier day', async () => {
    const slots = await computeDaySlots(
      page(),
      '2026-05-04',
      source([{ startTime: '2026-05-02T00:00:00Z', endTime: '2026-05-05T00:00:00Z', status: 'confirmed' }]),
      NOW,
    );
    assert.deepEqual(availableStarts(slots), []);
  });

  it('looks for events as far as the buffers reach past the day', async () => {
    const src = source();
    await computeDaySlots(page({ bufferBeforeMinutes: 30, bufferAfterMinutes: 45 }), '2026-05-04', src, NOW);
    const [from, to] = src.calls.busy[0] ?? [];
    assert.ok(from && to);
    assert.equal(from.toISOString(), '2026-05-03T23:30:00.000Z');
    assert.equal(to.toISOString(), '2026-05-05T00:45:00.000Z');
  });

  it('closes a day that reached maxBookingsPerDay, and only counts when a cap is set', async () => {
    const full = await computeDaySlots(page({ maxBookingsPerDay: 2 }), '2026-05-04', source([], 2), NOW);
    assert.equal(full.length, 4);
    assert.deepEqual(availableStarts(full), []);

    const room = await computeDaySlots(page({ maxBookingsPerDay: 3 }), '2026-05-04', source([], 2), NOW);
    assert.equal(availableStarts(room).length, 4);

    const uncapped = source([], 99);
    assert.equal(availableStarts(await computeDaySlots(page(), '2026-05-04', uncapped, NOW)).length, 4);
    assert.equal(uncapped.calls.counts.length, 0);
  });

  it('counts bookings over the page-timezone day', async () => {
    const src = source();
    await computeDaySlots(
      page({ timezone: 'Europe/Amsterdam', maxBookingsPerDay: 1 }),
      '2026-05-04',
      src,
      NOW,
    );
    const [from, to] = src.calls.counts[0] ?? [];
    assert.ok(from && to);
    assert.equal(from.toISOString(), '2026-05-03T22:00:00.000Z');
    assert.equal(to.toISOString(), '2026-05-04T22:00:00.000Z');
  });

  it('applies the minimum notice', async () => {
    const slots = await computeDaySlots(
      page({ minNoticeMinutes: 90 }),
      '2026-05-04',
      source(),
      new Date('2026-05-04T08:00:00Z'),
    );
    // Earliest start is 09:30.
    assert.deepEqual(availableStarts(slots), ['09:30', '10:00', '10:30']);
  });
});

describe('isSlotStillAvailable', () => {
  const start = '2026-05-04T09:00:00.000Z';
  const end = '2026-05-04T09:30:00.000Z';

  it('is true for a free slot of the page', async () => {
    assert.equal(await isSlotStillAvailable(page(), start, end, source(), NOW), true);
  });

  it('is false once an event took the slot', async () => {
    const taken = source([{ startTime: start, endTime: end, status: 'confirmed' }]);
    assert.equal(await isSlotStillAvailable(page(), start, end, taken, NOW), false);
  });

  it('is false for a time that is not one of the page slots', async () => {
    assert.equal(
      await isSlotStillAvailable(page(), '2026-05-04T09:10:00.000Z', '2026-05-04T09:40:00.000Z', source(), NOW),
      false,
    );
    assert.equal(
      await isSlotStillAvailable(page(), start, '2026-05-04T10:00:00.000Z', source(), NOW),
      false,
    );
  });

  it('finds the page-timezone day of a slot that is on another UTC day', async () => {
    // 00:30 Amsterdam on Tuesday the 5th is Monday 22:30Z: the UTC date differs.
    const tuesdayPage = page({
      timezone: 'Europe/Amsterdam',
      weekly: { tuesday: [{ start: '00:00', end: '02:00' }] },
    });
    assert.equal(
      await isSlotStillAvailable(
        tuesdayPage,
        '2026-05-04T22:30:00.000Z',
        '2026-05-04T23:00:00.000Z',
        source(),
        NOW,
      ),
      true,
    );
  });

  it('is false for a closed (override) or full day', async () => {
    const closed = page({ overrides: [{ date: '2026-05-04', slots: [] }] });
    assert.equal(await isSlotStillAvailable(closed, start, end, source(), NOW), false);
    const full = page({ maxBookingsPerDay: 1 });
    assert.equal(await isSlotStillAvailable(full, start, end, source([], 1), NOW), false);
  });
});
