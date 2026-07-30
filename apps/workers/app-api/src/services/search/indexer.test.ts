/**
 * Indexer tests.
 *
 * Split in two: the pure chunker is tested directly, and the index/backfill
 * control flow runs against a real (pglite) database with a stub embedder.
 * Stubbing only the network call is deliberate — the interesting behaviour is
 * the skip-if-unchanged decision, the chunk reconciliation and the cursor
 * walk, all of which are database interactions that a mocked DB would not
 * actually exercise.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';
import {
  chunkText,
  hashContent,
  indexDocument,
  indexEntity,
  removeFromIndex,
  backfillBatch,
  initialBackfillCursor,
  EMBED_DIMENSIONS,
  type Embedder,
} from './indexer';
import type { IndexableDocument } from './documents';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

/**
 * Deterministic stand-in for Workers AI. Counts calls so tests can assert that
 * an unchanged record costs zero embeddings — the whole point of the hash.
 */
function createStubEmbedder() {
  let calls = 0;
  let vectorsProduced = 0;
  const embedder: Embedder = {
    async embed(texts) {
      calls += 1;
      vectorsProduced += texts.length;
      return texts.map((t) => {
        const v = new Array<number>(EMBED_DIMENSIONS).fill(0);
        // Vary by content so different text yields a different vector.
        v[t.length % EMBED_DIMENSIONS] = 1;
        return v;
      });
    },
  };
  return {
    embedder,
    get calls() {
      return calls;
    },
    get vectorsProduced() {
      return vectorsProduced;
    },
  };
}

function doc(overrides: Partial<IndexableDocument> = {}): IndexableDocument {
  return {
    entityType: 'knowledge_page',
    entityId: 'kp_1',
    title: 'Welding safety',
    subtitle: 'Handbook',
    url: '/weldknow/page/kp_1',
    content: 'Welding safety\nAlways wear a mask.',
    ...overrides,
  };
}

async function chunkRows(entityType: string, entityId: string) {
  return db
    .select()
    .from(schema.searchIndex)
    .where(
      and(
        eq(schema.searchIndex.entityType, entityType),
        eq(schema.searchIndex.entityId, entityId),
      ),
    )
    .orderBy(schema.searchIndex.chunkIndex);
}

describe('chunkText', () => {
  it('keeps short content as a single chunk', () => {
    expect(chunkText('a short page')).toEqual(['a short page']);
  });

  it('returns nothing for blank content', () => {
    expect(chunkText('   \n  ')).toEqual([]);
  });

  it('splits long content into several chunks', () => {
    const paragraph = 'x'.repeat(900);
    const chunks = chunkText([paragraph, paragraph, paragraph].join('\n\n'));
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('hard-splits a single paragraph longer than the target', () => {
    const chunks = chunkText('y'.repeat(5000));
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk stays within the cap that keeps retrieval focused.
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(1200);
  });

  it('caps runaway records instead of emitting thousands of chunks', () => {
    const chunks = chunkText('z'.repeat(500_000));
    expect(chunks.length).toBeLessThanOrEqual(40);
  });
});

describe('hashContent', () => {
  it('is stable for identical text and differs otherwise', async () => {
    const a = await hashContent('same');
    const b = await hashContent('same');
    const c = await hashContent('different');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(64);
  });
});

describe('indexDocument', () => {
  beforeEach(async () => {
    await db.delete(schema.searchIndex);
  });

  it('embeds and stores a document', async () => {
    const stub = createStubEmbedder();
    const result = await indexDocument(db, stub.embedder, doc());

    expect(result.embedded).toBe(1);
    const rows = await chunkRows('knowledge_page', 'kp_1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('Welding safety');
    expect(rows[0]!.embedding).toHaveLength(EMBED_DIMENSIONS);
  });

  it('skips re-embedding when the content is unchanged', async () => {
    const stub = createStubEmbedder();
    await indexDocument(db, stub.embedder, doc());
    expect(stub.calls).toBe(1);

    const second = await indexDocument(db, stub.embedder, doc());

    expect(second.embedded).toBe(0);
    expect(second.skipped).toBe(1);
    // The point of the content hash: a no-op update costs no embedding.
    expect(stub.calls).toBe(1);
  });

  it('re-embeds when the content actually changes', async () => {
    const stub = createStubEmbedder();
    await indexDocument(db, stub.embedder, doc());
    const second = await indexDocument(db, stub.embedder, doc({ content: 'Welding safety\nWear gloves too.' }));

    expect(second.embedded).toBe(1);
    expect(stub.calls).toBe(2);
    const rows = await chunkRows('knowledge_page', 'kp_1');
    expect(rows[0]!.content).toContain('gloves');
  });

  it('updates the denormalised title without duplicating the row', async () => {
    const stub = createStubEmbedder();
    await indexDocument(db, stub.embedder, doc());
    await indexDocument(db, stub.embedder, doc({ title: 'Renamed', content: 'Renamed\nAlways wear a mask.' }));

    const rows = await chunkRows('knowledge_page', 'kp_1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('Renamed');
  });

  it('drops surplus chunks when a record shrinks', async () => {
    const stub = createStubEmbedder();
    const long = Array.from({ length: 6 }, (_, i) => `${'p'.repeat(900)}${i}`).join('\n\n');
    const first = await indexDocument(db, stub.embedder, doc({ content: long }));
    expect(first.embedded).toBeGreaterThan(1);

    const shrunk = await indexDocument(db, stub.embedder, doc({ content: 'now very short' }));

    expect(shrunk.removed).toBeGreaterThan(0);
    const rows = await chunkRows('knowledge_page', 'kp_1');
    expect(rows).toHaveLength(1);
  });

  it('removes the record entirely when its content becomes empty', async () => {
    const stub = createStubEmbedder();
    await indexDocument(db, stub.embedder, doc());
    const emptied = await indexDocument(db, stub.embedder, doc({ content: '   ' }));

    expect(emptied.removed).toBe(1);
    expect(await chunkRows('knowledge_page', 'kp_1')).toHaveLength(0);
  });

  it('refuses a mismatched embedder response rather than storing wrong vectors', async () => {
    const broken: Embedder = { async embed() { return []; } };
    await expect(indexDocument(db, broken, doc())).rejects.toThrow(/vectors for/);
  });
});

describe('removeFromIndex', () => {
  it('deletes every chunk of one record and leaves others alone', async () => {
    await db.delete(schema.searchIndex);
    const stub = createStubEmbedder();
    await indexDocument(db, stub.embedder, doc({ entityId: 'kp_a' }));
    await indexDocument(db, stub.embedder, doc({ entityId: 'kp_b' }));

    const removed = await removeFromIndex(db, 'knowledge_page', 'kp_a');

    expect(removed).toBe(1);
    expect(await chunkRows('knowledge_page', 'kp_a')).toHaveLength(0);
    expect(await chunkRows('knowledge_page', 'kp_b')).toHaveLength(1);
  });
});

describe('indexEntity against real rows', () => {
  const pageId = generateId('kpg');
  const spaceId = generateId('ksp');

  beforeEach(async () => {
    await db.delete(schema.searchIndex);
  });

  it('indexes a knowledge page and drops it again once soft-deleted', async () => {
    await db.insert(schema.knowledgeSpaces).values({
      id: spaceId,
      name: 'Engineering',
      visibility: 'workspace',
    } as typeof schema.knowledgeSpaces.$inferInsert);
    await db.insert(schema.knowledgePages).values({
      id: pageId,
      spaceId,
      title: 'Torch maintenance',
      contentText: 'Clean the nozzle after every shift.',
    } as typeof schema.knowledgePages.$inferInsert);

    const stub = createStubEmbedder();
    const indexed = await indexEntity(db, stub.embedder, 'knowledge_page', pageId);
    expect(indexed.embedded).toBe(1);
    expect(await chunkRows('knowledge_page', pageId)).toHaveLength(1);

    // Soft-delete: the loader stops returning it, so the indexer must clean up.
    await db
      .update(schema.knowledgePages)
      .set({ deletedAt: new Date() })
      .where(eq(schema.knowledgePages.id, pageId));

    const afterDelete = await indexEntity(db, stub.embedder, 'knowledge_page', pageId);
    expect(afterDelete.removed).toBe(1);
    expect(await chunkRows('knowledge_page', pageId)).toHaveLength(0);
  });

  it('is a no-op for an id that does not exist', async () => {
    const stub = createStubEmbedder();
    const result = await indexEntity(db, stub.embedder, 'knowledge_page', 'kp_missing');
    expect(result.embedded).toBe(0);
    expect(stub.calls).toBe(0);
  });
});

describe('backfillBatch page boundaries', () => {
  // 30 > BACKFILL_PAGE_SIZE (25), so the walk must take more than one page —
  // and some rows map to null, which is precisely the case that used to make
  // the cursor treat a partly-filtered page as the end of the entity type.
  const TOTAL = 30;
  const NAMELESS = 4;
  /**
   * The nameless rows sit INSIDE the first page, not at the tail — that
   * placement is what makes this a regression test. With them at the end, the
   * last page is short either way and the buggy and correct implementations
   * agree. Inside a full page, the old code saw 21 documents from 25 scanned
   * rows, concluded the type was exhausted, and abandoned rows 25-29.
   */
  const NAMELESS_FROM = 5;

  beforeAll(async () => {
    await db.delete(schema.searchIndex);
    await db.delete(schema.companies);

    const rows = Array.from({ length: TOTAL }, (_, i) => ({
      // Zero-padded so lexicographic id order matches insertion order; the
      // cursor pages with `gt(id)`, so a stable ordering is load-bearing.
      id: `cmp_bf_${String(i).padStart(3, '0')}`,
      // These have no name at all, so `toDocument` returns null and they
      // vanish from `documents` while still counting as scanned rows.
      name: i >= NAMELESS_FROM && i < NAMELESS_FROM + NAMELESS ? '' : `Backfill Corp ${i}`,
      // Required by the table but not read by the customer mapper, which keys
      // off `name`/`tradingName` — so these rows still map to null.
      displayName: `row ${i}`,
    }));
    await db
      .insert(schema.companies)
      .values(rows as unknown as (typeof schema.companies.$inferInsert)[]);
  }, 60_000);

  it('indexes every mappable record across page boundaries', async () => {
    const stub = createStubEmbedder();
    let cursor: ReturnType<typeof initialBackfillCursor> | null = {
      entityType: 'customer',
      afterId: null,
    };
    let scanned = 0;

    // Walk only the `customer` type; stop as soon as the cursor moves on.
    for (let i = 0; i < 50 && cursor && cursor.entityType === 'customer'; i += 1) {
      const progress = await backfillBatch(db, stub.embedder, cursor);
      scanned += progress.processed;
      cursor = progress.cursor;
    }

    // Every row was scanned — not just the ones that produced a document.
    expect(scanned).toBe(TOTAL);

    const indexed = await db
      .select({ entityId: schema.searchIndex.entityId })
      .from(schema.searchIndex)
      .where(eq(schema.searchIndex.entityType, 'customer'));

    // …and every mappable row landed in the index. Deriving the cursor from the
    // filtered array instead of the scanned rows loses records here.
    expect(indexed).toHaveLength(TOTAL - NAMELESS);
  });
});

describe('backfillBatch', () => {
  it('walks every indexed entity type and terminates', async () => {
    const stub = createStubEmbedder();
    let cursor = initialBackfillCursor();
    const seen: string[] = [];

    // Bounded so a cursor bug fails the test instead of hanging it.
    for (let i = 0; i < 200; i += 1) {
      const progress = await backfillBatch(db, stub.embedder, cursor);
      seen.push(cursor.entityType);
      if (progress.done || !progress.cursor) {
        cursor = initialBackfillCursor();
        expect(progress.done).toBe(true);
        break;
      }
      cursor = progress.cursor;
      expect(i).toBeLessThan(199);
    }

    // It should have advanced past the first type rather than stalling.
    expect(new Set(seen).size).toBeGreaterThan(1);
  });
});
