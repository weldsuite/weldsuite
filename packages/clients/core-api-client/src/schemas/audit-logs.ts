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

/** An `audit_logs` row, as /api/audit-logs answers it. */
export const auditLogSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  action: z.string(),
  description: z.string(),
  changes: z.record(z.unknown()).nullable(),
  data: z.record(z.unknown()).nullable(),
  performedBy: z.string().nullable(),
  performedByName: z.string().nullable(),
  ipAddress: z.string().nullable(),
  metadata: z.record(z.unknown()).nullable(),
});

/** POST / and PATCH /:id: the row's id. */
export const auditLogRefSchema = z.object({ id: z.string() });

export type AuditLog = z.infer<typeof auditLogSchema>;
