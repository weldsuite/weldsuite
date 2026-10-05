import { z } from 'zod';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** One bookable window within a day, 24h "HH:MM" wall-clock in the page timezone. */
export const bookingTimeRangeSchema = z.object({
  start: z.string().regex(HHMM, 'Expected HH:MM'),
  end: z.string().regex(HHMM, 'Expected HH:MM'),
});

export const WEEKDAY_KEYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

export type AvailabilityProblem =
  | { kind: 'end-before-start'; day: WeekdayKey; index: number }
  | { kind: 'overlap'; day: WeekdayKey; index: number };

type RangeLike = { start: string; end: string };

/**
 * Finds the first invalid range in a weekly availability object: a range that
 * does not end after it starts, or one that overlaps another range on the same
 * day. Ranges that merely touch (17:00 end, 17:00 start) are fine. Pure, so
 * the editor and the API apply the same rule.
 */
export function findAvailabilityProblem(
  availability: Partial<Record<WeekdayKey, readonly RangeLike[] | undefined>> | null | undefined,
): AvailabilityProblem | null {
  if (!availability) return null;
  for (const day of WEEKDAY_KEYS) {
    const ranges = availability[day] ?? [];
    for (let index = 0; index < ranges.length; index += 1) {
      const range = ranges[index];
      if (range.start >= range.end) return { kind: 'end-before-start', day, index };
    }
    const sorted = ranges
      .map((range, index) => ({ range, index }))
      .sort((a, b) => a.range.start.localeCompare(b.range.start));
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i].range.start < sorted[i - 1].range.end) {
        return { kind: 'overlap', day, index: sorted[i].index };
      }
    }
  }
  return null;
}

const dayRanges = z.array(bookingTimeRangeSchema).max(24).optional();

/** Weekly availability. Rejects ranges that end before they start and overlapping ranges. */
export const weeklyAvailabilitySchema = z
  .object({
    monday: dayRanges,
    tuesday: dayRanges,
    wednesday: dayRanges,
    thursday: dayRanges,
    friday: dayRanges,
    saturday: dayRanges,
    sunday: dayRanges,
  })
  .superRefine((value, ctx) => {
    const problem = findAvailabilityProblem(value);
    if (!problem) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [problem.day, problem.index],
      message:
        problem.kind === 'end-before-start'
          ? `${problem.day}: end time must be after start time`
          : `${problem.day}: time ranges must not overlap`,
    });
  });

/** A custom field on the public booking form. Answers are stored on the booking. */
export const bookingQuestionSchema = z
  .object({
    id: z.string().min(1).max(100),
    label: z.string().trim().min(1).max(200),
    type: z.enum(['text', 'textarea', 'select']),
    required: z.boolean(),
    options: z.array(z.string().min(1).max(200)).max(50).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.type === 'select' && (!value.options || value.options.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'A select field needs at least one option',
      });
    }
  });

/** A real calendar date written YYYY-MM-DD (rejects 2026-02-30). */
export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Availability for one specific date, in the page timezone. It REPLACES the
 * weekly availability for that date; empty `slots` means not bookable that day.
 */
export const bookingDateOverrideSchema = z
  .object({
    date: z.string().refine(isValidIsoDate, 'Expected a date as YYYY-MM-DD'),
    slots: z.array(bookingTimeRangeSchema).max(24),
  })
  .superRefine((value, ctx) => {
    const ranges = value.slots;
    for (let index = 0; index < ranges.length; index += 1) {
      if (ranges[index].start >= ranges[index].end) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['slots', index],
          message: 'End time must be after start time',
        });
        return;
      }
    }
    const sorted = ranges
      .map((range, index) => ({ range, index }))
      .sort((a, b) => a.range.start.localeCompare(b.range.start));
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i].range.start < sorted[i - 1].range.end) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['slots', sorted[i].index],
          message: 'Time ranges must not overlap',
        });
        return;
      }
    }
  });

/** Up to a year of overrides, one entry per date. */
export const bookingDateOverridesSchema = z
  .array(bookingDateOverrideSchema)
  .max(366)
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.forEach((override, index) => {
      if (seen.has(override.date)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'date'],
          message: 'Each date can only have one override',
        });
      }
      seen.add(override.date);
    });
  });

export type BookingDateOverride = z.infer<typeof bookingDateOverrideSchema>;

export const createBookingPageSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(255),
  description: z.string().optional(),
  ownerId: z.string().nullish(),
  isActive: z.boolean().optional(),
  durationMinutes: z.number().int().optional(),
  availability: weeklyAvailabilitySchema.optional(),
  questions: z.array(bookingQuestionSchema).max(20).nullish(),
  /** Minutes of notice required before a slot can be booked. */
  minNotice: z.number().int().min(0).optional(),
  /** How many days ahead a slot can be booked (>= 1). */
  maxAdvance: z.number().int().min(1).optional(),
  /** Per-date availability replacing the weekly one; null clears all overrides. */
  dateOverrides: bookingDateOverridesSchema.nullish(),
  /** Max non-cancelled bookings per day in the page timezone; null or 0 = unlimited. */
  maxBookingsPerDay: z.number().int().min(0).nullish(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateBookingPageSchema = createBookingPageSchema.partial();
export type CreateBookingPageInput = z.infer<typeof createBookingPageSchema>;
export type UpdateBookingPageInput = z.infer<typeof updateBookingPageSchema>;
export type BookingQuestionInput = z.infer<typeof bookingQuestionSchema>;
