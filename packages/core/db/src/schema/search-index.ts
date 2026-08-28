import {
  pgTable,
  varchar,
  timestamp,
  integer,
  text,
  vector,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Semantic search index — one row per embedded chunk of a searchable record.
 *
 * Lives in the TENANT database, not a separate vector store. That is the whole
 * design decision, and it follows from the multi-tenant model: every workspace
 * already has its own physical Neon database, so tenant isolation is a property
 * of the connection rather than a metadata filter someone has to remember to
 * apply. It also means the semantic leg can `JOIN` back to the live source row,
 * so `deleted_at`, space visibility and every other predicate the lexical leg
 * enforces come for free instead of being mirrored into vector metadata.
 *
 * Requires `CREATE EXTENSION IF NOT EXISTS vector;` in each tenant DB.
 *
 * Deliberately generic (`entity_type` + `entity_id`) rather than a vector column
 * per searchable table: adding a new searchable entity becomes a registry entry
 * in the search service, not a fresh migration across every tenant.
 *
 * Platform-wide semantic index; stores vectors inline in the tenant DB.
 */
export const searchIndex = pgTable(
  'search_index',
  {
    id: varchar('id', { length: 30 }).primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),

    /** Matches SEARCH_ENTITY_TYPES in @weldsuite/app-api-client/schemas/search. */
    entityType: varchar('entity_type', { length: 30 }).notNull(),
    entityId: varchar('entity_id', { length: 30 }).notNull(),
    /** Long records are split; short ones are a single chunk 0. */
    chunkIndex: integer('chunk_index').notNull().default(0),

    /** The plain text that was embedded — kept for reranking and snippets. */
    content: text('content').notNull(),
    /**
     * SHA-256 of `content`. Lets the indexer skip re-embedding on a mutation
     * that didn't touch any searchable field, which is most of them.
     */
    contentHash: varchar('content_hash', { length: 64 }).notNull(),

    /**
     * 1024 dimensions — `@cf/baai/bge-m3` via Workers AI. Multilingual, which
     * is the deciding factor for an en/nl product: an English-only embedding
     * model puts Dutch records in a different region of the space than the
     * English query that should find them.
     *
     * NOT NULL on purpose. Nothing writes a row before embedding it, and a null
     * vector would be invisible to the ANN query while still occupying the
     * record's unique slot — a bug that silently drops a record from search
     * rather than failing. The constraint turns that into an insert error.
     */
    embedding: vector('embedding', { dimensions: 1024 }).notNull(),
    /**
     * Which model produced `embedding`. Vectors from different models are not
     * comparable, so a model change means a re-embed — this column is what
     * makes the stale rows findable instead of silently degrading recall.
     */
    embedModel: varchar('embed_model', { length: 100 }).notNull(),

    /** Denormalised for rendering a result without a join back to the source. */
    title: varchar('title', { length: 500 }),
    subtitle: varchar('subtitle', { length: 500 }),
    url: varchar('url', { length: 500 }),
  },
  (table) => [
    uniqueIndex('search_index_entity_chunk_idx').on(
      table.entityType,
      table.entityId,
      table.chunkIndex,
    ),
    // No standalone index on `entity_type`: the composite unique index above
    // is (entity_type, entity_id, chunk_index), so a type-only filter is
    // already served by its leftmost prefix. A second one would just add
    // write and storage cost.
    //
    // Re-embed sweeps after a model change scan by model id.
    index('search_index_embed_model_idx').on(table.embedModel),
    // NOTE: the HNSW index on `embedding` is intentionally absent from this
    // schema and created by hand in the migration (0175_dapper_sumo.sql), as
    // `USING hnsw (embedding vector_cosine_ops)`. Drizzle can express it, but
    // the operator class and build-time trade-offs are clearer stated in SQL.
    // Anything regenerating this table must carry that index across.
  ],
);

export type SearchIndexRow = typeof searchIndex.$inferSelect;
export type NewSearchIndexRow = typeof searchIndex.$inferInsert;
