import { z } from 'zod';

// ============================================================================
// Pipeline Stages — `/api/pipeline-stages`.
//
// Backed by `crm_pipeline_stages`. The `pipeline` column groups stages
// under a pipeline (default = 'default'). Position is 0-based.
// ============================================================================

export const createPipelineStageSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  position: z.number().int().min(0).default(0),
  probability: z.number().int().min(0).max(100).optional(),
  color: z.string().max(50).optional(),
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
