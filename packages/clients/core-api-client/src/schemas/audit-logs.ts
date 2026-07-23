import { z } from 'zod';

export const createAuditLogSchema = z.object({
  userId: z.string().nullish(),
  action: z.string().max(100).optional(),
  entityType: z.string().max(50).optional(),
  entityId: z.string().nullish(),
  details: z.unknown().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateAuditLogSchema = createAuditLogSchema.partial();
export type CreateAuditLogInput = z.infer<typeof createAuditLogSchema>;
export type UpdateAuditLogInput = z.infer<typeof updateAuditLogSchema>;
