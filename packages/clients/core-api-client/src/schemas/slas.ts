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

/** A `helpdesk_slas` row, as /api/slas returns it. */
export const slaSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    name: z.string(),
    description: z.string().nullable(),
    conditions: z.unknown(),
    isDefault: z.boolean().nullable(),
    firstResponseTime: z.unknown(),
    resolutionTime: z.unknown(),
    updateTime: z.unknown(),
    operationalHours: z.string(),
    businessHours: z.unknown(),
    escalationRules: z.unknown(),
    isActive: z.boolean(),
    priority: z.number().nullable(),
    reminders: z.unknown(),
  })
  .passthrough();
