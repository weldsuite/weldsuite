import { z } from 'zod';

// ============================================================================
// Pipeline Stages — `/api/pipeline-stages`.
//
// Backed by `crm_pipeline_stages`. The `pipeline` column groups stages
// under a pipeline (default = 'default'). Position is 0-based.
// ============================================================================

export const createPipelineStageSchema = z.object({
  name: z.string().min(1).max(255),
  // Export/duplicate round-trips a stage's own nullable columns (e.g. an
  // unset description or color) straight back into this schema, so these
  // accept `null` as well as `undefined`, not just a missing field.
  description: z.string().max(1000).nullish(),
  // `position` is optional server-side: when omitted, the create route
  // appends the stage after the last open stage (before any isWon/isLost
  // stage) instead of defaulting to 0.
  position: z.number().int().min(0).optional(),
  probability: z.number().int().min(0).max(100).nullish(),
  color: z.string().max(50).nullish(),
  pipeline: z.string().max(100).default('default'),
  isDefault: z.boolean().optional(),
  isWon: z.boolean().optional(),
  isLost: z.boolean().optional(),
});

export const updatePipelineStageSchema = createPipelineStageSchema.partial();

export const listPipelineStagesQuery = z.object({
  pipeline: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).default(100),
});

export const reorderPipelineStagesSchema = z.object({
  pipeline: z.string().default('default'),
  ids: z.array(z.string()).min(1),
});

export type CreatePipelineStageInput = z.infer<typeof createPipelineStageSchema>;
export type UpdatePipelineStageInput = z.infer<typeof updatePipelineStageSchema>;
export type ListPipelineStagesQuery = z.infer<typeof listPipelineStagesQuery>;
export type ReorderPipelineStagesInput = z.infer<typeof reorderPipelineStagesSchema>;

export interface PipelineStage {
  id: string;
  name: string;
  description?: string | null;
  position: number;
  probability?: number | null;
  color?: string | null;
  pipeline?: string | null;
  isDefault?: boolean | null;
  isWon?: boolean | null;
  isLost?: boolean | null;
  createdAt: string;
  updatedAt: string;
}
