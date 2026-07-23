// AUTO-COPIED from @weldsuite/core-api-client/schemas/milestones
// Self-contained Zod schemas vendored into mcp-server so it no longer
// depends on @weldsuite/{core-api,app-api}-client. Keep in sync with source.

import { z } from 'zod';

export const createMilestoneSchema = z.object({
  name: z.string().min(1).max(255),
  projectId: z.string().nullish(),
  description: z.string().optional(),
  dueDate: z.string().optional(),
  status: z.string().max(30).optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateMilestoneSchema = createMilestoneSchema.partial();
export type CreateMilestoneInput = z.infer<typeof createMilestoneSchema>;
export type UpdateMilestoneInput = z.infer<typeof updateMilestoneSchema>;
