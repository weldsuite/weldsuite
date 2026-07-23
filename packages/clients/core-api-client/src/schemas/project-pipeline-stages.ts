import { z } from 'zod';

export const createProjectPipelineStageSchema = z.object({
  name: z.string().min(1).max(255),
  projectId: z.string().nullish(),
  position: z.number().int().optional(),
  color: z.string().max(50).optional(),
  isDefault: z.boolean().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
export const updateProjectPipelineStageSchema = createProjectPipelineStageSchema.partial();
export type CreateProjectPipelineStageInput = z.infer<typeof createProjectPipelineStageSchema>;
export type UpdateProjectPipelineStageInput = z.infer<typeof updateProjectPipelineStageSchema>;
