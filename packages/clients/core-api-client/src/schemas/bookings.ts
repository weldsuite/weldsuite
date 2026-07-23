import { z } from 'zod';

export const createBookingSchema = z.object({
  bookingPageId: z.string().nullish(),
  customerName: z.string().max(255).optional(),
  customerEmail: z.string().email().max(255).optional(),
  startsAt: z.string(),
  endsAt: z.string(),
  status: z.string().max(30).optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateBookingSchema = createBookingSchema.partial();
export type CreateBookingInput = z.infer<typeof createBookingSchema>;
export type UpdateBookingInput = z.infer<typeof updateBookingSchema>;
