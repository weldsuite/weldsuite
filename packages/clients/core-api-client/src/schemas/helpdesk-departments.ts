import { z } from 'zod';

// `/api/helpdesk-departments` — backed by `helpdesk_departments`.

export const createHelpdeskDepartmentSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  email: z.string().email().max(255).optional(),
  color: z.string().max(50).optional(),
  icon: z.string().max(100).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateHelpdeskDepartmentSchema = createHelpdeskDepartmentSchema.partial();

export type CreateHelpdeskDepartmentInput = z.infer<typeof createHelpdeskDepartmentSchema>;
export type UpdateHelpdeskDepartmentInput = z.infer<typeof updateHelpdeskDepartmentSchema>;
