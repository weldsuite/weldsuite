import { z } from 'zod';

// `/api/helpdesk-faqs` — backed by `helpdesk_faqs`.

export const createHelpdeskFaqSchema = z.object({
  question: z.string().min(1),
  answer: z.string(),
  category: z.string().max(100).optional(),
  sortOrder: z.number().int().optional(),
  isPublished: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateHelpdeskFaqSchema = createHelpdeskFaqSchema.partial();

export type CreateHelpdeskFaqInput = z.infer<typeof createHelpdeskFaqSchema>;
export type UpdateHelpdeskFaqInput = z.infer<typeof updateHelpdeskFaqSchema>;
