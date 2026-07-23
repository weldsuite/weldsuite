import { z } from 'zod';

// ============================================================================
// Enrichments — `/api/enrichments`.
//
// Read-only views over the enrichment data:
//   - GET /enrichments              → latest field results for an entity
//   - GET /enrichments/definitions  → enabled enrichment fields for an entity type
//   - GET /enrichments/logs         → audit trail of provider calls
//
// Triggering an enrichment (Trigger.dev job) remains in api-worker for now.
// ============================================================================

export const listEnrichmentResultsQuery = z.object({
  entityType: z.string(),
  entityId: z.string(),
});

export const listEnrichmentDefinitionsQuery = z.object({
  entityType: z.string(),
  enabled: z.coerce.boolean().optional(),
});

export const listEnrichmentLogsQuery = z.object({
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
});

export type ListEnrichmentResultsQuery = z.infer<typeof listEnrichmentResultsQuery>;
export type ListEnrichmentDefinitionsQuery = z.infer<typeof listEnrichmentDefinitionsQuery>;
export type ListEnrichmentLogsQuery = z.infer<typeof listEnrichmentLogsQuery>;

export interface EnrichmentResult {
  id: string;
  enrichFieldId: string;
  entityType: string;
  entityId: string;
  provider: string;
  operation: string;
  status: string;
  resultData?: unknown;
  enrichmentLogId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnrichmentDefinition {
  id: string;
  provider: string;
  operation: string;
  entityType: string;
  name: string;
  slug: string;
  enabled: boolean;
  sortOrder: number;
  config?: unknown;
}

export interface EnrichmentLog {
  id: string;
  provider: string;
  operation: string;
  entityType: string;
  entityId: string;
  userId: string;
  status: string;
  errorMessage?: string | null;
  creditsUsed?: number | null;
  requestParams?: unknown;
  responseData?: unknown;
  createdAt: string;
  completedAt?: string | null;
}
