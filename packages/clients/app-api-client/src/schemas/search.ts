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
  'knowledge_page',
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
// Semantic reindex (POST /api/search/reindex)
// ============================================================================

/**
 * Cursor for the batched semantic backfill. Opaque to the caller: hand back
 * whatever the previous batch returned until it reports `done`.
 */
export const backfillCursorSchema = z.object({
  entityType: searchEntityTypeSchema,
  afterId: z.string().nullable(),
});

export type BackfillCursor = z.infer<typeof backfillCursorSchema>;

/** Omit `cursor` to start a fresh backfill from the first indexed type. */
export const reindexInputSchema = z.object({
  cursor: backfillCursorSchema.nullish(),
});

export type ReindexInput = z.infer<typeof reindexInputSchema>;

export interface ReindexProgress {
  cursor: BackfillCursor | null;
  done: boolean;
  processed: number;
  embedded: number;
  skipped: number;
}

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

/**
 * How the server structured a natural-language query before running it.
 *
 * `source` records which tier resolved it:
 *  - `lexical`      — not structured; an identifier or short prefix
 *  - `lexicon`      — the en/nl entity-keyword strip, no model call
 *  - `model`        — Workers AI structured parse
 *  - `model_failed` — parse unavailable, fell back to the raw query
 *
 * Optional so existing clients (and any cached response) stay valid.
 */
export interface SearchUnderstanding {
  source: 'lexical' | 'lexicon' | 'model' | 'model_failed';
  entityTypes: SearchEntityType[];
  lexicalTerm: string;
}

export interface SearchResponse {
  data: SearchResultGroup[];
  query: string;
  permittedTypes: SearchEntityType[];
  understanding?: SearchUnderstanding;
}
