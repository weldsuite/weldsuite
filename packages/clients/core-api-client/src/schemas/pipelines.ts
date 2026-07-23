import { z } from 'zod';

// ============================================================================
// Field Visibility — per-pipeline configuration of which fields render in the
// deals grid and on each kanban card. Stored on `crmPipelines.settings.fieldVisibility`.
// ============================================================================

export const pipelineFieldVisibilitySchema = z.object({
  grid: z.array(z.string().min(1).max(120)).max(200).optional(),
  kanban: z.array(z.string().min(1).max(120)).max(200).optional(),
});

export const updatePipelineFieldVisibilitySchema = pipelineFieldVisibilitySchema;

export type PipelineFieldVisibility = z.infer<typeof pipelineFieldVisibilitySchema>;
export type UpdatePipelineFieldVisibilityInput = z.infer<typeof updatePipelineFieldVisibilitySchema>;
