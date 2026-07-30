/**
 * Semantic search indexer — keeps `search_index` in step with tenant data.
 *
 * Two entry points, one code path:
 *  - {@link indexEntity}      — incremental, driven by an entity event
 *  - {@link backfillBatch}    — one bounded page of an initial index build
 *
 * The expensive thing here is the embedding call, so the design is built
 * around not making it. Each chunk carries a SHA-256 of its text; a mutation
 * that didn't touch a searchable field produces an identical hash and the
 * chunk is skipped. Most updates touch a status or an assignee, so in steady
 * state the majority of events cost one SELECT and nothing else.
 *
 * Failure posture matches the rest of search: indexing is best-effort. A
 * failed embed leaves the previous vector in place (stale, still useful)
 * rather than deleting it, and never propagates into the caller's request.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  assertGatewayConfigured,
  createWeldAI,
  embedMany,
  recommended,
} from '@weldsuite/ai';
import type { SearchEntityType } from '@weldsuite/app-api-client/schemas/search';
import type { Env } from '../../types';
import type { Database } from '../../db';
import { schema } from '../../db';
import { generateId } from '../../lib/id';
import {
  getDocumentLoader,
  INDEXED_ENTITY_TYPES,
  type IndexableDocument,
} from './documents';

/** bge-m3: multilingual, 1024 dims — must match the column width. */
export const EMBED_MODEL = recommended.embed.free;
export const EMBED_DIMENSIONS = 1024;

/**
 * Target chunk size in characters. bge-m3 accepts far more, but retrieval
 * quality degrades as a chunk covers more distinct topics — a whole knowledge
 * page averaged into one vector matches everything weakly and nothing well.
 */
const CHUNK_CHARS = 1200;
const CHUNK_OVERLAP_CHARS = 150;
/** Guard against a pathological record generating thousands of embed calls. */
const MAX_CHUNKS_PER_ENTITY = 40;

// ---------------------------------------------------------------------------
// Chunking + hashing
// ---------------------------------------------------------------------------

/**
 * Split text on paragraph boundaries, packing up to {@link CHUNK_CHARS} and
 * carrying a small overlap so a sentence spanning a boundary still matches.
 * A paragraph longer than the target on its own is hard-split.
 */
export function chunkText(text: string): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= CHUNK_CHARS) return [clean];

  const paragraphs = clean.split(/\n{2,}|\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';

  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > CHUNK_CHARS) {
      push();
      for (let i = 0; i < paragraph.length; i += CHUNK_CHARS - CHUNK_OVERLAP_CHARS) {
        chunks.push(paragraph.slice(i, i + CHUNK_CHARS));
        if (chunks.length >= MAX_CHUNKS_PER_ENTITY) return chunks.slice(0, MAX_CHUNKS_PER_ENTITY);
      }
      continue;
    }

    if (current.length + paragraph.length + 1 > CHUNK_CHARS) {
      push();
      if (chunks.length >= MAX_CHUNKS_PER_ENTITY) return chunks.slice(0, MAX_CHUNKS_PER_ENTITY);
    }
    current = current ? `${current}\n${paragraph}` : paragraph;
  }
  push();

  return chunks.slice(0, MAX_CHUNKS_PER_ENTITY);
}

/** SHA-256 hex of a chunk — the skip-if-unchanged key. */
export async function hashContent(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Workers AI embedder. Split out behind an interface so the indexer's control
 * flow — chunking, hashing, skip decisions, upserts — is testable against a
 * real database without reaching the network.
 */
export function createEmbedder(env: Env): Embedder {
  assertGatewayConfigured(env);
  const ai = createWeldAI(env);
  return {
    async embed(texts) {
      const { embeddings } = await embedMany({
        model: ai.embedding(EMBED_MODEL),
        values: texts,
      });
      return embeddings;
    },
  };
}

// ---------------------------------------------------------------------------
// Indexing one entity
// ---------------------------------------------------------------------------

export interface IndexResult {
  entityType: SearchEntityType;
  entityId: string;
  /** Chunks whose text changed and were re-embedded. */
  embedded: number;
  /** Chunks skipped because the content hash matched. */
  skipped: number;
  /** Rows deleted because the record shrank or disappeared. */
  removed: number;
}

const EMPTY_RESULT = (entityType: SearchEntityType, entityId: string): IndexResult => ({
  entityType,
  entityId,
  embedded: 0,
  skipped: 0,
  removed: 0,
});

/** Drop every indexed chunk for a record. Used on delete and soft-delete. */
export async function removeFromIndex(
  db: Database,
  entityType: SearchEntityType,
  entityId: string,
): Promise<number> {
  const deleted = await db
    .delete(schema.searchIndex)
    .where(
      and(
        eq(schema.searchIndex.entityType, entityType),
        eq(schema.searchIndex.entityId, entityId),
      ),
    )
    .returning({ id: schema.searchIndex.id });
  return deleted.length;
}

/**
 * Bring one record's chunks in line with its current content.
 *
 * Re-reads the record, so it is safe to call on any mutation without knowing
 * what changed — and correct when several events for one record arrive out of
 * order, since the last writer simply re-reads the same final row.
 */
export async function indexDocument(
  db: Database,
  embedder: Embedder,
  doc: IndexableDocument,
): Promise<IndexResult> {
  const result = EMPTY_RESULT(doc.entityType, doc.entityId);
  const chunks = chunkText(doc.content);

  if (chunks.length === 0) {
    result.removed = await removeFromIndex(db, doc.entityType, doc.entityId);
    return result;
  }

  const existing = await db
    .select({
      chunkIndex: schema.searchIndex.chunkIndex,
      contentHash: schema.searchIndex.contentHash,
      embedModel: schema.searchIndex.embedModel,
    })
    .from(schema.searchIndex)
    .where(
      and(
        eq(schema.searchIndex.entityType, doc.entityType),
        eq(schema.searchIndex.entityId, doc.entityId),
      ),
    );

  const existingByIndex = new Map(existing.map((r) => [r.chunkIndex, r]));
  const hashes = await Promise.all(chunks.map(hashContent));

  // A chunk needs work when its text changed OR when it was embedded by a
  // different model — vectors from two models are not comparable, so a model
  // switch has to re-embed even though the content is untouched.
  const stale: Array<{ index: number; text: string; hash: string }> = [];
  chunks.forEach((text, index) => {
    const prior = existingByIndex.get(index);
    if (prior && prior.contentHash === hashes[index] && prior.embedModel === EMBED_MODEL) {
      result.skipped += 1;
      return;
    }
    stale.push({ index, text, hash: hashes[index]! });
  });

  // The record got shorter: drop the chunk rows that no longer have content.
  const surplus = existing.filter((r) => r.chunkIndex >= chunks.length).map((r) => r.chunkIndex);
  if (surplus.length > 0) {
    await db
      .delete(schema.searchIndex)
      .where(
        and(
          eq(schema.searchIndex.entityType, doc.entityType),
          eq(schema.searchIndex.entityId, doc.entityId),
          inArray(schema.searchIndex.chunkIndex, surplus),
        ),
      );
    result.removed = surplus.length;
  }

  if (stale.length === 0) return result;

  const vectors = await embedder.embed(stale.map((s) => s.text));
  if (vectors.length !== stale.length) {
    throw new Error(
      `[search-indexer] embedder returned ${vectors.length} vectors for ${stale.length} chunks`,
    );
  }

  await db
    .insert(schema.searchIndex)
    .values(
      stale.map((s, i) => ({
        id: generateId('sidx'),
        entityType: doc.entityType,
        entityId: doc.entityId,
        chunkIndex: s.index,
        content: s.text,
        contentHash: s.hash,
        embedding: vectors[i]!,
        embedModel: EMBED_MODEL,
        title: doc.title.slice(0, 500),
        subtitle: doc.subtitle?.slice(0, 500) ?? null,
        url: doc.url.slice(0, 500),
      })),
    )
    .onConflictDoUpdate({
      target: [
        schema.searchIndex.entityType,
        schema.searchIndex.entityId,
        schema.searchIndex.chunkIndex,
      ],
      set: {
        content: sql`excluded.content`,
        contentHash: sql`excluded.content_hash`,
        embedding: sql`excluded.embedding`,
        embedModel: sql`excluded.embed_model`,
        title: sql`excluded.title`,
        subtitle: sql`excluded.subtitle`,
        url: sql`excluded.url`,
        updatedAt: sql`now()`,
      },
    });

  result.embedded = stale.length;
  return result;
}

/**
 * Index one record by id, resolving its document through the loader registry.
 * A record that no longer loads — deleted, soft-deleted, or moved into a
 * private space — is removed from the index instead.
 */
export async function indexEntity(
  db: Database,
  embedder: Embedder,
  entityType: SearchEntityType,
  entityId: string,
): Promise<IndexResult> {
  const loader = getDocumentLoader(entityType);
  if (!loader) return EMPTY_RESULT(entityType, entityId);

  const doc = await loader.load(db, entityId);
  if (!doc) {
    const result = EMPTY_RESULT(entityType, entityId);
    result.removed = await removeFromIndex(db, entityType, entityId);
    return result;
  }

  return indexDocument(db, embedder, doc);
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

export interface BackfillCursor {
  /** Which entity type this page is walking. */
  entityType: SearchEntityType;
  /** Last id processed, exclusive. `null` starts the type. */
  afterId: string | null;
}

export interface BackfillProgress {
  cursor: BackfillCursor | null;
  done: boolean;
  processed: number;
  embedded: number;
  skipped: number;
}

/** Records pulled per batch. Kept small — each one may cost an embed call. */
const BACKFILL_PAGE_SIZE = 25;

/** The first cursor of a full backfill. */
export function initialBackfillCursor(): BackfillCursor {
  return { entityType: INDEXED_ENTITY_TYPES[0]!, afterId: null };
}

/** The cursor for the type after this one, or `null` when the walk is over. */
function nextEntityType(current: SearchEntityType): BackfillCursor | null {
  const at = INDEXED_ENTITY_TYPES.indexOf(current);
  const next = INDEXED_ENTITY_TYPES[at + 1];
  return next ? { entityType: next, afterId: null } : null;
}

/**
 * Index one bounded page and return the cursor for the next.
 *
 * Deliberately batch-at-a-time rather than a single long-running sweep: a
 * Worker has a wall-clock and CPU budget, and a tenant with a large corpus
 * would exceed it. The caller loops on `done`, which also makes the backfill
 * resumable after a failure — the cursor is the entire state.
 */
export async function backfillBatch(
  db: Database,
  embedder: Embedder,
  cursor: BackfillCursor,
): Promise<BackfillProgress> {
  const loader = getDocumentLoader(cursor.entityType);
  if (!loader) {
    const next = nextEntityType(cursor.entityType);
    return { cursor: next, done: next === null, processed: 0, embedded: 0, skipped: 0 };
  }

  const docs = await loader.page(db, cursor.afterId, BACKFILL_PAGE_SIZE);

  if (docs.length === 0) {
    const next = nextEntityType(cursor.entityType);
    return { cursor: next, done: next === null, processed: 0, embedded: 0, skipped: 0 };
  }

  let embedded = 0;
  let skipped = 0;
  for (const doc of docs) {
    // One failing record must not abort the page — the cursor would stall on
    // it forever and the backfill could never pass that row.
    try {
      const result = await indexDocument(db, embedder, doc);
      embedded += result.embedded;
      skipped += result.skipped;
    } catch (err) {
      console.error(
        `[search-indexer] failed to index ${doc.entityType}/${doc.entityId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const lastId = docs[docs.length - 1]!.entityId;
  // A short page means this type is exhausted; move on rather than spend a
  // whole round trip discovering it next time.
  const exhausted = docs.length < BACKFILL_PAGE_SIZE;
  const next = exhausted
    ? nextEntityType(cursor.entityType)
    : { entityType: cursor.entityType, afterId: lastId };

  return {
    cursor: next,
    done: next === null,
    processed: docs.length,
    embedded,
    skipped,
  };
}
