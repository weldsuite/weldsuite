import { z } from 'zod';

// `/api/slas` — backed by `helpdesk_slas`. SLA policies that drive ticket
// response/resolution deadlines.

export const createSlaSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  priority: z.string().max(20).optional(),
  responseTimeMinutes: z.number().int().optional(),
  resolutionTimeMinutes: z.number().int().optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateSlaSchema = createSlaSchema.partial();

export type CreateSlaInput = z.infer<typeof createSlaSchema>;
export type UpdateSlaInput = z.infer<typeof updateSlaSchema>;
