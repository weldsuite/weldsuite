import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { buildSeedMailRows, seedInsertChunkSize, type SeedMailBulkOptions } from './seed-mail-bulk';

const NOW = new Date('2026-10-28T12:00:00Z');
const MARKER = '[E2E_TEST]';

function options(overrides: Partial<SeedMailBulkOptions> = {}): SeedMailBulkOptions {
  return {
    accountId: 'mail_seed',
    accountEmail: 'seed@e2e.test',
    count: 7,
    threadSize: 3,
    bodyBytes: 500,
    unreadRatio: 0.5,
    spreadDays: 30,
    labels: ['INBOX'],
    marker: MARKER,
    now: NOW,
    batch: 'b1',
    ...overrides,
  };
}

describe('buildSeedMailRows', () => {
  it('groups messages into threads that replies point back to', () => {
    const rows = buildSeedMailRows(options());

    expect(rows).toHaveLength(7);
    expect(new Set(rows.map((r) => r.threadId)).size).toBe(3);
    expect(rows[0]).toMatchObject({ messageId: '<bulk-b1-t0@e2e.test>', threadId: '<bulk-b1-t0@e2e.test>', inReplyTo: null });
    expect(rows[1]).toMatchObject({ threadId: '<bulk-b1-t0@e2e.test>', inReplyTo: '<bulk-b1-t0@e2e.test>' });
    expect(rows[6]).toMatchObject({ messageId: '<bulk-b1-t2@e2e.test>' });
  });

  it('spreads threads from now back over spreadDays, newest first', () => {
    const rows = buildSeedMailRows(options());
    expect(rows[0]?.receivedDate).toEqual(NOW);
    expect(rows[6]?.receivedDate).toEqual(new Date(NOW.getTime() - 30 * 86_400_000));
  });

  it('marks the requested share of threads unread and sizes the bodies', () => {
    const rows = buildSeedMailRows(options());
    // unreadRatio 0.5: threads 0 and 2 unread, thread 1 read.
    expect(rows.map((r) => r.isRead)).toEqual([false, false, false, true, true, true, false]);
    expect(rows[0]?.textBody).toHaveLength(500);
    expect(rows[0]?.preview).toHaveLength(200);
    expect(rows[0]?.customFields).toEqual({ __e2e: MARKER });
  });

  it('marks everything read with an unread ratio of 0', () => {
    expect(buildSeedMailRows(options({ unreadRatio: 0 })).every((r) => r.isRead)).toBe(true);
  });

  it('keeps one insert around 2 MB', () => {
    expect(seedInsertChunkSize(4_000)).toBe(222);
    expect(seedInsertChunkSize(50_000)).toBe(19);
    expect(seedInsertChunkSize(0)).toBe(2_000);
  });
});

describe('buildSeedMailRows on the tenant schema', () => {
  let db: Database;

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
    await db.insert(schema.mailAccounts).values({
      id: 'mail_seed',
      name: 'Seed',
      email: 'seed@e2e.test',
    } as unknown as typeof schema.mailAccounts.$inferInsert);
  }, 60_000);

  it('inserts, and the reset marker finds every row', async () => {
    await db.insert(schema.mailMessages).values(buildSeedMailRows(options({ count: 10, batch: 'pg' })));

    const marked = await db
      .select({ id: schema.mailMessages.id })
      .from(schema.mailMessages)
      .where(sql`(${schema.mailMessages.customFields} ->> '__e2e') = ${MARKER}`);
    const threads = await db
      .selectDistinct({ threadId: schema.mailMessages.threadId })
      .from(schema.mailMessages)
      .where(eq(schema.mailMessages.accountId, 'mail_seed'));

    expect(marked).toHaveLength(10);
    expect(threads).toHaveLength(4);
  });
});
