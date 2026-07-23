/**
 * Zod schemas for the booking-portal.
 *
 * Two roles:
 *   1. Validate JSONB columns (`availability`, `questions`) at the server boundary
 *      so the client never sees a corrupt page.
 *   2. Validate user input on `createBooking` so we don't trust raw form posts.
 */

import { z } from 'zod';

import { DAY_NAMES } from './constants';

// ── Page-shape validation ──────────────────────────────────────────────────

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const hhmm = z.string().regex(HHMM, 'Expected HH:MM');

export const timeRangeSchema = z.object({
  start: hhmm,
  end: hhmm,
});

export const weeklyAvailabilitySchema = z.object(
  Object.fromEntries(
    DAY_NAMES.map((d) => [d, z.array(timeRangeSchema).optional()]),
  ) as Record<(typeof DAY_NAMES)[number], z.ZodOptional<z.ZodArray<typeof timeRangeSchema>>>,
);

export const bookingQuestionSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.string(),
  required: z.boolean(),
  options: z.array(z.string()).optional(),
});

export const bookingPagePropsSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  duration: z.number().int().positive(),
  bufferBefore: z.number().int().nullable(),
  bufferAfter: z.number().int().nullable(),
  color: z.string().nullable(),
  locationType: z.string().nullable(),
  locationValue: z.string().nullable(),
  availability: weeklyAvailabilitySchema,
  questions: z.array(bookingQuestionSchema).default([]),
  minNotice: z.number().int().nullable(),
  maxAdvance: z.number().int().nullable(),
  confirmationMessage: z.string().nullable(),
  timezone: z.string(),
});

export type TimeRange = z.infer<typeof timeRangeSchema>;
export type WeeklyAvailability = z.infer<typeof weeklyAvailabilitySchema>;
export type BookingQuestion = z.infer<typeof bookingQuestionSchema>;
export type BookingPageProps = z.infer<typeof bookingPagePropsSchema>;

// ── createBooking input ───────────────────────────────────────────────────

const isoDateTime = z.string().datetime({ offset: true });

export const createBookingInputSchema = z.object({
  workspaceSlug: z.string().min(1),
  bookingPageId: z.string().min(1),
  bookerName: z.string().min(1).max(255),
  bookerEmail: z.string().email().max(255),
  startTime: isoDateTime,
  endTime: isoDateTime,
  answers: z.record(z.string(), z.string()).optional(),
  notes: z.string().max(2000).optional(),
  guests: z
    .array(
      z.object({
        email: z.string().email(),
        name: z.string().optional(),
      }),
    )
    .max(20)
    .optional(),
});

export type CreateBookingInput = z.infer<typeof createBookingInputSchema>;

// ── cancelBooking / rescheduleBooking input ─────────────────────────────────

export const cancelBookingInputSchema = z.object({
  workspaceSlug: z.string().min(1),
  bookingId: z.string().min(1),
  reason: z.string().max(2000).optional(),
});

export type CancelBookingInput = z.infer<typeof cancelBookingInputSchema>;

export const rescheduleBookingInputSchema = z.object({
  workspaceSlug: z.string().min(1),
  bookingId: z.string().min(1),
  startTime: isoDateTime,
  endTime: isoDateTime,
});

export type RescheduleBookingInput = z.infer<typeof rescheduleBookingInputSchema>;
