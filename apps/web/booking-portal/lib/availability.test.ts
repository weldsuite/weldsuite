import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addDaysToDate,
  buildSlots,
  eventBlocksWindow,
  findSlot,
  hasBookableDate,
  hasBookableRange,
  isBeyondMaxAdvance,
  isDayFull,
  isInsideMinNotice,
  isValidRange,
  mondayFirstOffset,
  rangesForDate,
  sanitizeAvailability,
  weekdayOfDate,
  type AvailabilityRange,
  type BusyEvent,
} from './availability.ts';

describe('isValidRange', () => {
  it('requires the end to be after the start', () => {
    assert.equal(isValidRange({ start: '09:00', end: '17:00' }), true);
    assert.equal(isValidRange({ start: '18:00', end: '17:00' }), false);
    assert.equal(isValidRange({ start: '09:00', end: '09:00' }), false);
    assert.equal(isValidRange({ start: '', end: '17:00' }), false);
  });
});

describe('sanitizeAvailability', () => {
  it('drops ranges that can never produce a slot and keeps the rest', () => {
    const cleaned = sanitizeAvailability({
      monday: [{ start: '18:00', end: '17:00' }],
      tuesday: [
        { start: '09:00', end: '12:00' },
        { start: '15:00', end: '14:00' },
      ],
    });
    assert.deepEqual(cleaned, { monday: [], tuesday: [{ start: '09:00', end: '12:00' }] });
  });
});

describe('hasBookableRange', () => {
  it('needs a range at least as long as the appointment', () => {
    assert.equal(hasBookableRange([{ start: '09:00', end: '09:20' }], 30), false);
    assert.equal(hasBookableRange([{ start: '09:00', end: '09:30' }], 30), true);
    assert.equal(
      hasBookableRange(
        [
          { start: '09:00', end: '09:20' },
          { start: '13:00', end: '15:00' },
        ],
        30,
      ),
      true,
    );
    assert.equal(hasBookableRange([{ start: '18:00', end: '17:00' }], 30), false);
    assert.equal(hasBookableRange([], 30), false);
    assert.equal(hasBookableRange(undefined, 30), false);
  });
});

describe('weekdayOfDate', () => {
  it('reads the weekday of the calendar date itself', () => {
    assert.equal(weekdayOfDate('2026-05-04'), 'monday');
    assert.equal(weekdayOfDate('2026-05-10'), 'sunday');
    assert.equal(weekdayOfDate('nope'), null);
  });
});

describe('mondayFirstOffset', () => {
  it('maps JS weekdays onto a Monday-first grid', () => {
    assert.equal(mondayFirstOffset(1), 0); // Monday
    assert.equal(mondayFirstOffset(2), 1);
    assert.equal(mondayFirstOffset(0), 6); // Sunday
  });
});

// ── Availability rules ─────────────────────────────────────────────────────

const WEEKLY = {
  monday: [{ start: '09:00', end: '12:00' }],
  tuesday: [{ start: '09:00', end: '12:00' }],
};

describe('rangesForDate', () => {
  it('uses the weekday ranges when there is no override', () => {
    assert.deepEqual(rangesForDate('2026-05-04', WEEKLY, []), [{ start: '09:00', end: '12:00' }]);
    assert.deepEqual(rangesForDate('2026-05-06', WEEKLY, null), []);
  });

  it('lets an override replace the weekly ranges for that date only', () => {
    const overrides = [{ date: '2026-05-04', slots: [{ start: '13:00', end: '15:00' }] }];
    assert.deepEqual(rangesForDate('2026-05-04', WEEKLY, overrides), [{ start: '13:00', end: '15:00' }]);
    assert.deepEqual(rangesForDate('2026-05-11', WEEKLY, overrides), [{ start: '09:00', end: '12:00' }]);
  });

  it('closes the day when the override has no slots', () => {
    assert.deepEqual(rangesForDate('2026-05-04', WEEKLY, [{ date: '2026-05-04', slots: [] }]), []);
  });

  it('can open a day the week keeps closed', () => {
    const overrides = [{ date: '2026-05-06', slots: [{ start: '10:00', end: '11:00' }] }];
    assert.deepEqual(rangesForDate('2026-05-06', WEEKLY, overrides), [{ start: '10:00', end: '11:00' }]);
    assert.equal(hasBookableDate('2026-05-06', WEEKLY, overrides, 30), true);
    assert.equal(hasBookableDate('2026-05-06', WEEKLY, [], 30), false);
  });

  it('drops override ranges that can never hold a slot', () => {
    const overrides = [{ date: '2026-05-04', slots: [{ start: '15:00', end: '14:00' }] }];
    assert.deepEqual(rangesForDate('2026-05-04', WEEKLY, overrides), []);
  });
});

describe('max advance', () => {
  it('adds days to a calendar date', () => {
    assert.equal(addDaysToDate('2026-02-27', 3), '2026-03-02');
    assert.equal(addDaysToDate('nope', 3), null);
  });

  it('allows up to and including the last day, not beyond', () => {
    assert.equal(isBeyondMaxAdvance('2026-05-11', '2026-05-04', 7), false);
    assert.equal(isBeyondMaxAdvance('2026-05-12', '2026-05-04', 7), true);
  });

  it('falls back to 60 days when the page does not say', () => {
    assert.equal(isBeyondMaxAdvance('2026-07-03', '2026-05-04', null), false);
    assert.equal(isBeyondMaxAdvance('2026-07-04', '2026-05-04', undefined), true);
  });
});

describe('min notice', () => {
  const now = new Date('2026-05-04T10:00:00Z');
  it('rejects slots that start before now + notice', () => {
    assert.equal(isInsideMinNotice(new Date('2026-05-04T10:59:00Z'), now, 60), true);
    assert.equal(isInsideMinNotice(new Date('2026-05-04T11:00:00Z'), now, 60), false);
    assert.equal(isInsideMinNotice(new Date('2026-05-04T10:30:00Z'), now, 0), false);
  });
});

describe('isDayFull', () => {
  it('only caps when a positive maximum is reached', () => {
    assert.equal(isDayFull(2, 3), false);
    assert.equal(isDayFull(3, 3), true);
    assert.equal(isDayFull(10, 0), false);
    assert.equal(isDayFull(10, null), false);
  });
});

describe('eventBlocksWindow', () => {
  const windowStart = new Date('2026-05-04T09:00:00Z');
  const windowEnd = new Date('2026-05-04T09:30:00Z');
  const event = (over: Partial<BusyEvent>): BusyEvent => ({
    startTime: '2026-05-04T09:00:00Z',
    endTime: '2026-05-04T09:30:00Z',
    status: 'confirmed',
    ...over,
  });
  const blocks = (e: BusyEvent) => eventBlocksWindow(e, windowStart, windowEnd);

  it('blocks on overlap and not when the events only touch', () => {
    assert.equal(blocks(event({})), true);
    assert.equal(blocks(event({ startTime: '2026-05-04T09:30:00Z', endTime: '2026-05-04T10:00:00Z' })), false);
    assert.equal(blocks(event({ startTime: '2026-05-04T08:30:00Z', endTime: '2026-05-04T09:00:00Z' })), false);
    assert.equal(blocks(event({ startTime: '2026-05-04T09:15:00Z', endTime: '2026-05-04T09:45:00Z' })), true);
  });

  it('blocks when the event started on an earlier day (multi-day and all-day events)', () => {
    assert.equal(blocks(event({ startTime: '2026-05-02T00:00:00Z', endTime: '2026-05-06T00:00:00Z' })), true);
  });

  it('treats an event without an end as 30 minutes long', () => {
    assert.equal(blocks(event({ startTime: '2026-05-04T08:45:00Z', endTime: null })), true);
    assert.equal(blocks(event({ startTime: '2026-05-04T08:20:00Z', endTime: null })), false);
  });

  it('blocks for tentative, never for cancelled', () => {
    assert.equal(blocks(event({ status: 'tentative' })), true);
    assert.equal(blocks(event({ status: 'cancelled' })), false);
  });
});

describe('buildSlots', () => {
  const utc = (hhmm: string) => new Date(`2026-05-04T${hhmm}:00Z`);
  const ranges: AvailabilityRange[] = [{ start: '09:00', end: '11:00' }];
  const base = {
    ranges,
    durationMinutes: 30,
    minNoticeMinutes: 60,
    now: new Date('2026-05-01T00:00:00Z'),
    busy: [] as BusyEvent[],
    toInstant: utc,
  };
  const availableStarts = (slots: ReturnType<typeof buildSlots>) =>
    slots.filter((s) => s.available).map((s) => s.start.slice(11, 16));

  it('lists a slot per duration step inside the range', () => {
    assert.deepEqual(availableStarts(buildSlots(base)), ['09:00', '09:30', '10:00', '10:30']);
  });

  it('blocks slots that overlap an event, including a tentative one', () => {
    const slots = buildSlots({
      ...base,
      busy: [{ startTime: '2026-05-04T09:30:00Z', endTime: '2026-05-04T10:00:00Z', status: 'tentative' }],
    });
    assert.deepEqual(availableStarts(slots), ['09:00', '10:00', '10:30']);
  });

  it('widens the conflict test by the buffers without changing the slots', () => {
    const slots = buildSlots({
      ...base,
      bufferBeforeMinutes: 15,
      bufferAfterMinutes: 15,
      busy: [{ startTime: '2026-05-04T10:00:00Z', endTime: '2026-05-04T10:30:00Z', status: 'confirmed' }],
    });
    assert.deepEqual(availableStarts(slots), ['09:00']);
    assert.equal(slots.length, 4);
  });

  it('blocks slots inside the minimum notice', () => {
    const slots = buildSlots({ ...base, now: new Date('2026-05-04T09:15:00Z') });
    assert.deepEqual(availableStarts(slots), ['10:30']);
  });

  it('offers nothing on a full day', () => {
    const slots = buildSlots({ ...base, dayFull: true });
    assert.equal(slots.length, 4);
    assert.deepEqual(availableStarts(slots), []);
  });

  it('does not list a start twice when ranges overlap', () => {
    const slots = buildSlots({
      ...base,
      ranges: [
        { start: '09:00', end: '10:00' },
        { start: '09:30', end: '11:00' },
      ],
    });
    assert.deepEqual(slots.map((s) => s.start.slice(11, 16)), ['09:00', '09:30', '10:00', '10:30']);
  });

  it('returns nothing for a zero duration', () => {
    assert.deepEqual(buildSlots({ ...base, durationMinutes: 0 }), []);
  });
});

describe('findSlot', () => {
  const slots = [{ start: '2026-05-04T09:00:00.000Z', end: '2026-05-04T09:30:00.000Z', available: true }];
  it('matches by instant, whatever the offset spelling', () => {
    assert.ok(findSlot(slots, '2026-05-04T09:00:00Z', '2026-05-04T09:30:00Z'));
    assert.ok(findSlot(slots, '2026-05-04T11:00:00+02:00', '2026-05-04T11:30:00+02:00'));
    assert.equal(findSlot(slots, '2026-05-04T09:00:00Z', '2026-05-04T10:00:00Z'), undefined);
  });
});
