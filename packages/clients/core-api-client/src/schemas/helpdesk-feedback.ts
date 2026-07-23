import { z } from 'zod';

// `/api/helpdesk-feedback` — backed by `helpdesk_feedback`.

export const createHelpdeskFeedbackSchema = z.object({
  title: z.string().min(1).max(500),
  body: z.string().optional(),
  type: z.string().max(50).optional(),
  rating: z.number().int().min(1).max(5).optional(),
  customerName: z.string().max(255).optional(),
  customerEmail: z.string().email().max(255).optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateHelpdeskFeedbackSchema = createHelpdeskFeedbackSchema.partial();

export type CreateHelpdeskFeedbackInput = z.infer<typeof createHelpdeskFeedbackSchema>;
export type UpdateHelpdeskFeedbackInput = z.infer<typeof updateHelpdeskFeedbackSchema>;
