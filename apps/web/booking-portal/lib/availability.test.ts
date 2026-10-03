import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  hasBookableRange,
  isValidRange,
  mondayFirstOffset,
  sanitizeAvailability,
  weekdayOfDate,
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
