import { z } from 'zod';

export const createBookingPageSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(255),
  description: z.string().optional(),
  ownerId: z.string().nullish(),
  isActive: z.boolean().optional(),
  durationMinutes: z.number().int().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateBookingPageSchema = createBookingPageSchema.partial();
export type CreateBookingPageInput = z.infer<typeof createBookingPageSchema>;
export type UpdateBookingPageInput = z.infer<typeof updateBookingPageSchema>;
