import { z } from 'zod';

// ============================================================================
// CRM Pipelines — `/api/pipelines` (object-based catalog).
//
// Backed by `crm_pipelines`. Stage CRUD lives at `/api/pipeline-stages`.
// ============================================================================

export const createPipelineSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  icon: z.string().max(100).optional(),
  color: z.string().max(50).optional(),
  template: z.string().max(100).optional(),
  settings: z.unknown().optional(),
  isDefault: z.boolean().optional(),
});

export const updatePipelineSchema = createPipelineSchema.partial().extend({
  isArchived: z.boolean().optional(),
});

export const listPipelinesQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
  search: z.string().optional(),
  archived: z.enum(['active', 'archived', 'all']).default('active'),
});

export type CreatePipelineInput = z.infer<typeof createPipelineSchema>;
export type UpdatePipelineInput = z.infer<typeof updatePipelineSchema>;
export type ListPipelinesQuery = z.infer<typeof listPipelinesQuery>;

export interface PipelineRow {
  id: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  template?: string | null;
  settings?: unknown;
  isDefault?: boolean | null;
  isArchived?: boolean | null;
  createdAt: string;
  updatedAt: string;
}
