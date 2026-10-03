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

export const createBookingPageSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(255),
  description: z.string().optional(),
  ownerId: z.string().nullish(),
  isActive: z.boolean().optional(),
  durationMinutes: z.number().int().optional(),
  availability: weeklyAvailabilitySchema.optional(),
  questions: z.array(bookingQuestionSchema).max(20).nullish(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateBookingPageSchema = createBookingPageSchema.partial();
export type CreateBookingPageInput = z.infer<typeof createBookingPageSchema>;
export type UpdateBookingPageInput = z.infer<typeof updateBookingPageSchema>;
export type BookingQuestionInput = z.infer<typeof bookingQuestionSchema>;
