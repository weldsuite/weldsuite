import { describe, it, expect } from 'vitest';
import type { WeeklyAvailability } from '@/hooks/queries/use-calendar-queries';
import {
  adjustedAvailabilitySummary,
  bookedAppointmentSummary,
  buildSchedulePayload,
  findOverrideProblem,
  formatNotice,
  fromDateOverrides,
  hasUnsavedBookingChanges,
  hoursToMinutes,
  minutesToHours,
  parseNumberInput,
  schedulingWindowSummary,
  toDateOverrides,
  type BookingScheduleSettings,
  type SummaryLabels,
} from './booking-editor-settings';

const labels: SummaryLabels = {
  hour: 'hour',
  hours: 'hours',
  minutes: 'minutes',
  day: 'day',
  days: 'days',
  schedulingWindowSummary: '{days} in advance · {notice} before',
  bufferSummary: '{before} min before, {after} min after',
  bufferSummaryNone: 'No buffer',
  maxBookingsSummary: 'Max {count} per day',
  maxBookingsSummaryNone: 'No daily limit',
  bookedAppointmentSummary: '{buffer} · {limit}',
  adjustedAvailabilityHint: 'Indicate times you\'re available for specific dates',
  adjustedDatesSummaryOne: '1 adjusted date',
  adjustedDatesSummary: '{count} adjusted dates',
};

const weekdays: WeeklyAvailability = {
  monday: [{ start: '09:00', end: '17:00' }],
  tuesday: [],
  wednesday: [],
  thursday: [],
  friday: [],
  saturday: [],
  sunday: [],
};

const baseline: BookingScheduleSettings = {
  title: 'Intro call',
  duration: 30,
  availability: weekdays,
  bufferBefore: 0,
  bufferAfter: 0,
  minNotice: 60,
  maxAdvance: 60,
  dateOverrides: [],
  maxBookingsPerDay: 0,
};

describe('units', () => {
  it('shows minimum notice in hours and stores minutes', () => {
    expect(minutesToHours(60)).toBe(1);
    expect(minutesToHours(90)).toBe(1.5);
    expect(hoursToMinutes(4)).toBe(240);
    expect(hoursToMinutes(1.5)).toBe(90);
    expect(hoursToMinutes(0)).toBe(0);
    expect(hoursToMinutes(-2)).toBe(0);
  });

  it('parses number text, with a decimal comma, and rejects the rest', () => {
    expect(parseNumberInput('12')).toBe(12);
    expect(parseNumberInput(' 1,5 ')).toBe(1.5);
    expect(parseNumberInput('')).toBeNull();
    expect(parseNumberInput('1.')).toBe(1);
    expect(parseNumberInput('abc')).toBeNull();
  });
});

describe('date overrides', () => {
  it('round-trips the stored shape and sorts by date', () => {
    const stored = [
      { date: '2026-12-24', slots: [] },
      { date: '2026-11-02', slots: [{ start: '10:00', end: '12:00' }] },
    ];
    const rows = fromDateOverrides(stored);
    expect(rows.map((row) => row.date)).toEqual(['2026-11-02', '2026-12-24']);
    expect(rows[1].ranges).toEqual([]);
    expect(toDateOverrides(rows)).toEqual([
      { date: '2026-11-02', slots: [{ start: '10:00', end: '12:00' }] },
      { date: '2026-12-24', slots: [] },
    ]);
  });

  it('treats missing overrides as none', () => {
    expect(fromDateOverrides(null)).toEqual([]);
    expect(fromDateOverrides(undefined)).toEqual([]);
  });

  it('accepts an unavailable day and valid ranges', () => {
    expect(
      findOverrideProblem([
        { date: '2026-11-02', ranges: [] },
        { date: '2026-11-03', ranges: [{ start: '09:00', end: '12:00' }, { start: '12:00', end: '17:00' }] },
      ]),
    ).toBeNull();
  });

  it('flags a range that does not end after it starts, with its date and position', () => {
    expect(
      findOverrideProblem([
        { date: '2026-11-02', ranges: [{ start: '09:00', end: '12:00' }] },
        { date: '2026-11-03', ranges: [{ start: '09:00', end: '12:00' }, { start: '18:00', end: '17:00' }] },
      ]),
    ).toEqual({ kind: 'end-before-start', dateIndex: 1, index: 1 });
    expect(
      findOverrideProblem([{ date: '2026-11-02', ranges: [{ start: '10:00', end: '10:00' }] }]),
    ).toEqual({ kind: 'end-before-start', dateIndex: 0, index: 0 });
  });

  it('flags overlapping ranges on one date', () => {
    expect(
      findOverrideProblem([
        { date: '2026-11-02', ranges: [{ start: '09:00', end: '12:00' }, { start: '11:00', end: '13:00' }] },
      ]),
    ).toEqual({ kind: 'overlap', dateIndex: 0, index: 1 });
  });
});

describe('buildSchedulePayload', () => {
  it('carries every schedule setting and maps 0 bookings per day to null', () => {
    const payload = buildSchedulePayload({
      ...baseline,
      minNotice: 240,
      maxAdvance: 30,
      dateOverrides: [{ date: '2026-11-02', slots: [] }],
      maxBookingsPerDay: 0,
    });
    expect(payload).toEqual({
      duration: 30,
      availability: weekdays,
      bufferBefore: 0,
      bufferAfter: 0,
      minNotice: 240,
      maxAdvance: 30,
      dateOverrides: [{ date: '2026-11-02', slots: [] }],
      maxBookingsPerDay: null,
    });
  });

  it('keeps a positive daily limit', () => {
    expect(buildSchedulePayload({ ...baseline, maxBookingsPerDay: 5 }).maxBookingsPerDay).toBe(5);
  });
});

describe('hasUnsavedBookingChanges', () => {
  it('is false for an untouched form', () => {
    expect(hasUnsavedBookingChanges(baseline, { ...baseline })).toBe(false);
  });

  it('notices each of the new settings', () => {
    expect(hasUnsavedBookingChanges(baseline, { ...baseline, minNotice: 240 })).toBe(true);
    expect(hasUnsavedBookingChanges(baseline, { ...baseline, maxAdvance: 90 })).toBe(true);
    expect(hasUnsavedBookingChanges(baseline, { ...baseline, maxBookingsPerDay: 3 })).toBe(true);
    expect(
      hasUnsavedBookingChanges(baseline, {
        ...baseline,
        dateOverrides: [{ date: '2026-11-02', slots: [] }],
      }),
    ).toBe(true);
  });

  it('notices a weekly availability change', () => {
    expect(
      hasUnsavedBookingChanges(baseline, {
        ...baseline,
        availability: { ...weekdays, monday: [{ start: '08:00', end: '17:00' }] },
      }),
    ).toBe(true);
  });

  it('does not care about override order or object identity', () => {
    const a = { ...baseline, dateOverrides: [{ date: '2026-11-02', slots: [] }, { date: '2026-11-03', slots: [] }] };
    const b = { ...baseline, dateOverrides: [{ date: '2026-11-03', slots: [] }, { date: '2026-11-02', slots: [] }] };
    expect(hasUnsavedBookingChanges(a, b)).toBe(false);
  });
});

describe('summaries', () => {
  it('formats the notice in hours when whole, minutes otherwise', () => {
    expect(formatNotice(60, labels)).toBe('1 hour');
    expect(formatNotice(240, labels)).toBe('4 hours');
    expect(formatNotice(0, labels)).toBe('0 hours');
    expect(formatNotice(90, labels)).toBe('90 minutes');
  });

  it('reflects the current scheduling window', () => {
    expect(schedulingWindowSummary(60, 60, labels)).toBe('60 days in advance · 1 hour before');
    expect(schedulingWindowSummary(240, 1, labels)).toBe('1 day in advance · 4 hours before');
  });

  it('reflects buffers and the daily limit', () => {
    expect(bookedAppointmentSummary({ bufferBefore: 0, bufferAfter: 0, maxBookingsPerDay: 0 }, labels)).toBe(
      'No buffer · No daily limit',
    );
    expect(bookedAppointmentSummary({ bufferBefore: 5, bufferAfter: 10, maxBookingsPerDay: 4 }, labels)).toBe(
      '5 min before, 10 min after · Max 4 per day',
    );
  });

  it('counts adjusted dates', () => {
    expect(adjustedAvailabilitySummary(0, labels)).toBe(labels.adjustedAvailabilityHint);
    expect(adjustedAvailabilitySummary(1, labels)).toBe('1 adjusted date');
    expect(adjustedAvailabilitySummary(3, labels)).toBe('3 adjusted dates');
  });
});
