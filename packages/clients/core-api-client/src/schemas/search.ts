import { z } from 'zod';

// ============================================================================
// Entity Type Enum (forward-declared full set for stable client typing)
// ============================================================================

export const SEARCH_ENTITY_TYPES = [
  'contact',
  'customer',
  'lead',
  'opportunity',
  'ticket',
  'article',
  'product',
  'order',
  'invoice',
  'bill',
  'project',
  'task',
  'domain',
] as const;

/**
 * Runtime allow-list used by client (entity-sheet URL parsing) and server
 * (chat mention-token classification). Stays in sync with `SEARCH_ENTITY_TYPES`.
 */
export const SEARCH_ENTITY_TYPES_SET: ReadonlySet<string> = new Set<string>(
  SEARCH_ENTITY_TYPES,
);

export const searchEntityTypeSchema = z.enum(SEARCH_ENTITY_TYPES);
export type SearchEntityType = z.infer<typeof searchEntityTypeSchema>;

// ============================================================================
// Input Schema
// ============================================================================

export const searchInputSchema = z.object({
  q: z.string().trim().min(1).max(200),
  types: z.array(searchEntityTypeSchema).optional(),
  limit: z.coerce.number().int().min(1).max(20).optional().default(5),
});

export type SearchInput = z.infer<typeof searchInputSchema>;

// ============================================================================
// Response Types
// ============================================================================

export interface SearchResultItem {
  id: string;
  type: SearchEntityType;
  title: string;
  subtitle?: string | null;
  snippet?: string | null;
  url: string;
  score?: number | null;
}

export interface SearchResultGroup {
  type: SearchEntityType;
  items: SearchResultItem[];
  totalCount: number;
  hasMore: boolean;
}

export interface SearchResponse {
  data: SearchResultGroup[];
  query: string;
  permittedTypes: SearchEntityType[];
}
