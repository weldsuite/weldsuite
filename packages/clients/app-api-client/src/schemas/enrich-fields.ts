import { z } from 'zod';

// ============================================================================
// Enrich Field Definitions — configures which data-enrichment operations are
// enabled per entity type. Each row is one provider+operation pair
// (e.g. Hunter `email_verifier` for contacts). The (provider, operation,
// entityType) tuple is immutable after creation.
//
// Backed by the `enrich_field_definitions` table
// (packages/db/src/schema/enrich-field-definitions).
// Permission prefix: `settings:*` (these are org-level settings objects).
// ============================================================================

export const createEnrichFieldSchema = z.object({
  provider: z.string().min(1).max(50),
  operation: z.string().min(1).max(50),
  entityType: z.string().min(1).max(50),
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9_]+$/),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  config: z.record(z.unknown()).optional(),
});

// provider / operation / entityType are immutable — omit from updates.
export const updateEnrichFieldSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  config: z.record(z.unknown()).optional(),
});

export const reorderEnrichFieldsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      sortOrder: z.number().int(),
    }),
  ),
});

export type CreateEnrichFieldInput = z.infer<typeof createEnrichFieldSchema>;
export type UpdateEnrichFieldInput = z.infer<typeof updateEnrichFieldSchema>;
export type ReorderEnrichFieldsInput = z.infer<typeof reorderEnrichFieldsSchema>;
