import { findAvailabilityProblem } from '@weldsuite/core-api-client/schemas/booking-pages';
import type {
  BookingDateOverride,
  TimeRange,
  WeeklyAvailability,
} from '@/hooks/queries/use-calendar-queries';

/** What the API stores when the editor never set the value. */
export const DEFAULT_MIN_NOTICE_MINUTES = 60;
export const DEFAULT_MAX_ADVANCE_DAYS = 60;
export const DEFAULT_DURATION_MINUTES = 120;

const WEEKDAYS: readonly (keyof WeeklyAvailability)[] = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
];

/** A date with adjusted hours, as the editor edits it. `ranges` is `slots` on the API. */
export interface EditableOverride {
  date: string;
  ranges: TimeRange[];
}

export interface OverrideProblem {
  kind: 'end-before-start' | 'overlap';
  /** Index into the editor's (date-sorted) override list. */
  dateIndex: number;
  /** Index of the offending range inside that date. */
  index: number;
}

/** Everything the Schedule tab edits, in the units the API stores. */
export interface BookingScheduleSettings {
  title: string;
  duration: number;
  availability: WeeklyAvailability;
  bufferBefore: number;
  bufferAfter: number;
  /** Minutes. */
  minNotice: number;
  /** Days. */
  maxAdvance: number;
  dateOverrides: BookingDateOverride[];
  /** 0 = unlimited. */
  maxBookingsPerDay: number;
}

// ── Units ──────────────────────────────────────────────────────────────────

/** Minimum notice is stored in minutes but edited in hours (90 min -> 1.5). */
export const minutesToHours = (minutes: number): number => Math.round((minutes / 60) * 100) / 100;

export const hoursToMinutes = (hours: number): number => Math.max(0, Math.round(hours * 60));

/** Parses a number field's text. Returns null for empty or unusable input. */
export function parseNumberInput(text: string): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

// ── Date overrides ─────────────────────────────────────────────────────────

const sortByDate = <T extends { date: string }>(items: readonly T[]): T[] =>
  items.toSorted((a, b) => a.date.localeCompare(b.date));

/** Stored overrides -> editor rows, sorted by date. */
export function fromDateOverrides(overrides: readonly BookingDateOverride[] | null | undefined): EditableOverride[] {
  return sortByDate(
    (overrides ?? []).map((override) => ({
      date: override.date,
      ranges: (override.slots ?? []).map((slot) => ({ start: slot.start, end: slot.end })),
    })),
  );
}

/** Editor rows -> the API shape (sorted by date, one entry per date). */
export function toDateOverrides(rows: readonly EditableOverride[]): BookingDateOverride[] {
  return sortByDate(rows).map((row) => ({
    date: row.date,
    slots: row.ranges.map((range) => ({ start: range.start, end: range.end })),
  }));
}

/**
 * First override range that cannot produce a slot: it ends at or before its
 * start, or overlaps another range on the same date. Empty ranges (an
 * unavailable day) are valid. Mirrors the weekly availability rule.
 */
export function findOverrideProblem(rows: readonly EditableOverride[]): OverrideProblem | null {
  for (let dateIndex = 0; dateIndex < rows.length; dateIndex += 1) {
    const problem = findAvailabilityProblem({ monday: rows[dateIndex].ranges });
    if (problem) return { kind: problem.kind, dateIndex, index: problem.index };
  }
  return null;
}

// ── Payloads ───────────────────────────────────────────────────────────────

/** The schedule fields shared by the create payload, the edit payload and the drafts. */
export function buildSchedulePayload(settings: BookingScheduleSettings) {
  return {
    duration: settings.duration,
    availability: settings.availability,
    bufferBefore: settings.bufferBefore,
    bufferAfter: settings.bufferAfter,
    minNotice: settings.minNotice,
    maxAdvance: settings.maxAdvance,
    dateOverrides: settings.dateOverrides,
    maxBookingsPerDay: settings.maxBookingsPerDay > 0 ? settings.maxBookingsPerDay : null,
  };
}

// ── Unsaved changes ────────────────────────────────────────────────────────

const normalizeAvailability = (availability: WeeklyAvailability): string =>
  JSON.stringify(WEEKDAYS.map((day) => (availability[day] ?? []).map((r) => [r.start, r.end])));

const normalizeOverrides = (overrides: readonly BookingDateOverride[]): string =>
  JSON.stringify(sortByDate(overrides).map((o) => [o.date, o.slots.map((s) => [s.start, s.end])]));

/**
 * True when the form differs from `baseline`: the stored page when editing, the
 * untouched defaults when creating.
 */
export function hasUnsavedBookingChanges(
  baseline: BookingScheduleSettings,
  form: BookingScheduleSettings,
): boolean {
  return (
    form.title !== baseline.title ||
    form.duration !== baseline.duration ||
    form.bufferBefore !== baseline.bufferBefore ||
    form.bufferAfter !== baseline.bufferAfter ||
    form.minNotice !== baseline.minNotice ||
    form.maxAdvance !== baseline.maxAdvance ||
    form.maxBookingsPerDay !== baseline.maxBookingsPerDay ||
    normalizeAvailability(form.availability) !== normalizeAvailability(baseline.availability) ||
    normalizeOverrides(form.dateOverrides) !== normalizeOverrides(baseline.dateOverrides)
  );
}

// ── Section summaries ──────────────────────────────────────────────────────

function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

export interface SummaryLabels {
  hour: string;
  hours: string;
  minutes: string;
  day: string;
  days: string;
  schedulingWindowSummary: string;
  bufferSummary: string;
  bufferSummaryNone: string;
  maxBookingsSummary: string;
  maxBookingsSummaryNone: string;
  bookedAppointmentSummary: string;
  adjustedAvailabilityHint: string;
  adjustedDatesSummaryOne: string;
  adjustedDatesSummary: string;
}

/** "1 hour", "4 hours", "90 minutes". */
export function formatNotice(minutes: number, labels: Pick<SummaryLabels, 'hour' | 'hours' | 'minutes'>): string {
  if (minutes > 0 && minutes % 60 !== 0) return `${minutes} ${labels.minutes}`;
  const hours = minutes / 60;
  return `${hours} ${hours === 1 ? labels.hour : labels.hours}`;
}

export function schedulingWindowSummary(minNotice: number, maxAdvance: number, labels: SummaryLabels): string {
  return fill(labels.schedulingWindowSummary, {
    days: `${maxAdvance} ${maxAdvance === 1 ? labels.day : labels.days}`,
    notice: formatNotice(minNotice, labels),
  });
}

export function bookedAppointmentSummary(
  settings: Pick<BookingScheduleSettings, 'bufferBefore' | 'bufferAfter' | 'maxBookingsPerDay'>,
  labels: SummaryLabels,
): string {
  const buffer =
    settings.bufferBefore === 0 && settings.bufferAfter === 0
      ? labels.bufferSummaryNone
      : fill(labels.bufferSummary, { before: settings.bufferBefore, after: settings.bufferAfter });
  const limit =
    settings.maxBookingsPerDay > 0
      ? fill(labels.maxBookingsSummary, { count: settings.maxBookingsPerDay })
      : labels.maxBookingsSummaryNone;
  return fill(labels.bookedAppointmentSummary, { buffer, limit });
}

export function adjustedAvailabilitySummary(dateCount: number, labels: SummaryLabels): string {
  if (dateCount === 0) return labels.adjustedAvailabilityHint;
  return dateCount === 1
    ? labels.adjustedDatesSummaryOne
    : fill(labels.adjustedDatesSummary, { count: dateCount });
}
