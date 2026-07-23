import { z } from 'zod';

// `/api/helpdesk-workflows` — backed by `helpdesk_workflows`. CRUD only;
// trigger/execute actions stay in api-worker until the workflow binding
// lands in app-api.

export const createHelpdeskWorkflowSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  trigger: z.string().max(50).optional(),
  conditions: z.unknown().optional(),
  actions: z.unknown().optional(),
  isActive: z.boolean().optional(),
  priority: z.number().int().optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export const updateHelpdeskWorkflowSchema = createHelpdeskWorkflowSchema.partial();

export type CreateHelpdeskWorkflowInput = z.infer<typeof createHelpdeskWorkflowSchema>;
export type UpdateHelpdeskWorkflowInput = z.infer<typeof updateHelpdeskWorkflowSchema>;
