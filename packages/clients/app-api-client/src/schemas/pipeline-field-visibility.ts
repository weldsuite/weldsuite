import { z } from 'zod';

// ============================================================================
// Pipeline Field Visibility — per-pipeline configuration of which fields
// render in the deals grid and on each kanban card. Stored in the
// `crmPipelines.settings.fieldVisibility` JSONB sub-object; other pipeline
// settings keys are preserved on write.
//
// Backed by the `crm_pipelines.settings` JSONB column.
// Permission prefix: `pipelines:read` (GET), `pipelines:update` (PATCH).
// ============================================================================

export const pipelineFieldVisibilitySchema = z.object({
  grid: z.array(z.string().min(1).max(120)).max(200).optional(),
  kanban: z.array(z.string().min(1).max(120)).max(200).optional(),
});

export const updatePipelineFieldVisibilitySchema = pipelineFieldVisibilitySchema;

export type PipelineFieldVisibility = z.infer<typeof pipelineFieldVisibilitySchema>;
export type UpdatePipelineFieldVisibilityInput = z.infer<typeof updatePipelineFieldVisibilitySchema>;
