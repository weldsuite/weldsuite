/**
 * Full parity (design doc §4, task C4): seeded divergences are found
 * (missing / extra / labels / deleted / body presence), the documented
 * intended differences (AI-categories IMPORTANT label) are ignored, and
 * `repair: true` brings the object back in line with Postgres.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { createSqliteDurableObjectState } from '@weldsuite/worker-kit/testing/durable-sqlite';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { MailboxStoreObject, type MailboxStoreObjectEnv } from './mailbox-object';
import type { IngestMessage, MailboxRef } from '../store/types';

const { mailAccounts, mailMessages } = schema;

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

async function seedAccount(): Promise<string> {
  const id = generateId('mail');
  await db.insert(mailAccounts).values({ id, name: 'Parity test', email: `${id}@test.dev`, isShared: true });
  return id;
}

interface SeedPgOptions {
  labels?: string[];
  isImportant?: boolean;
  isRead?: boolean;
  deletedAt?: Date;
  textBody?: string;
  htmlBody?: string;
  threadId?: string;
}

async function seedPgMessage(accountId: string, id: string, opts: SeedPgOptions = {}): Promise<void> {
  await db.insert(mailMessages).values({
    id,
    accountId,
    threadId: opts.threadId ?? `thread_${id}`,
    messageId: `<${id}@test.dev>`,
    from: { email: 'sender@example.com', name: 'Sender' },
    to: [{ email: 'me@test.dev' }],
    subject: `Subject ${id}`,
    sentDate: new Date(),
    labels: opts.labels ?? ['INBOX'],
    isImportant: opts.isImportant ?? false,
    isRead: opts.isRead ?? false,
    deletedAt: opts.deletedAt,
    textBody: opts.textBody,
    htmlBody: opts.htmlBody,
  });
}

function testEnv(overrides: Partial<MailboxStoreObjectEnv> = {}): MailboxStoreObjectEnv {
  return {
    DATABASE_URL_MASTER: 'postgres://unused',
    WORKSPACE_CACHE: {} as KVNamespace,
    NEON_API_KEY: 'unused',
    MAIL_STORAGE: createMemoryR2(),
    tenantDbReader: async () => db,
    ...overrides,
  };
}

let seq = 0;
function makeIngest(id: string, overrides: Partial<IngestMessage> = {}): IngestMessage {
  seq += 1;
  return {
    id,
    source: 'inbound',
    rfcMessageId: `<${id}@test.dev>`,
    threadId: overrides.threadId ?? `thread_${id}`,
    from: { email: 'sender@example.com', name: 'Sender' },
    to: [{ email: 'me@test.dev' }],
    subject: `Subject ${id}`,
    preview: null,
    sentAt: Date.now(),
    receivedAt: Date.now(),
    createdAt: Date.now(),
    isRead: false,
    labels: ['INBOX'],
    isSpam: false,
    isReply: false,
    attachments: [],
    bodies: { html: false, text: false, raw: false },
    ...overrides,
  };
}

describe('full parity', () => {
  it('finds missing, extra, labels, deleted and body-presence divergences, and ignores the intended IMPORTANT-label difference', async () => {
    const accountId = await seedAccount();
    const ref: MailboxRef = { workspaceId: 'ws_parity', accountId, clerkOrgId: 'org_parity' };

    const state = createSqliteDurableObjectState();
    const object = new MailboxStoreObject(state, testEnv());

    // M1: identical on both sides — must not be reported.
    const m1 = generateId('mmsg');
    await seedPgMessage(accountId, m1, { labels: ['INBOX'] });
    await object.apply(ref, { kind: 'ingest', message: makeIngest(m1, { labels: ['INBOX'] }) });

    // M2: label set genuinely differs.
    const m2 = generateId('mmsg');
    await seedPgMessage(accountId, m2, { labels: ['INBOX'] });
    await object.apply(ref, { kind: 'ingest', message: makeIngest(m2, { labels: ['INBOX', 'STARRED'] }) });

    // M3: only in Postgres.
    const m3 = generateId('mmsg');
    await seedPgMessage(accountId, m3, { labels: ['INBOX'] });

    // M4: only in the object.
    const m4 = generateId('mmsg');
    await object.apply(ref, { kind: 'ingest', message: makeIngest(m4, { labels: ['INBOX'] }) });

    // M5: deleted state differs (Postgres soft-deleted, object still live).
    const m5 = generateId('mmsg');
    await seedPgMessage(accountId, m5, { labels: ['INBOX'], deletedAt: new Date() });
    await object.apply(ref, { kind: 'ingest', message: makeIngest(m5, { labels: ['INBOX'] }) });

    // M6: body presence differs (Postgres has an html body, object has none).
    const m6 = generateId('mmsg');
    await seedPgMessage(accountId, m6, { labels: ['INBOX'], htmlBody: '<p>hi</p>' });
    await object.apply(ref, { kind: 'ingest', message: makeIngest(m6, { labels: ['INBOX'], bodies: { html: false, text: false, raw: false } }) });

    // M7: the documented intended difference — Postgres has `isImportant`
    // true via the column only, the object expresses the same fact as the
    // IMPORTANT label (writes-extra.ts's own `categories` comment). Both
    // sides normalise to the same canonical label set, so this must NOT be
    // reported as `different`.
    const m7 = generateId('mmsg');
    await seedPgMessage(accountId, m7, { labels: ['INBOX'], isImportant: true });
    await object.apply(ref, { kind: 'ingest', message: makeIngest(m7, { labels: ['INBOX', 'IMPORTANT'] }) });

    const report = await object.runParity(ref, {});
    expect(report.done).toBe(true);
    expect(report.missing).toEqual([m3]);
    expect(report.extra).toEqual([m4]);

    const byId = new Map(report.different.map((d) => [d.id, d]));
    expect(byId.get(m1)).toBeUndefined();
    expect(byId.get(m2)?.reasons).toContain('labels');
    expect(byId.get(m5)?.reasons).toContain('deleted');
    expect(byId.get(m6)?.reasons).toContain('bodyPresence');
    expect(byId.has(m7)).toBe(false);
  });

  it('repair re-applies Postgres for missing and different rows, leaving extra rows untouched', async () => {
    const accountId = await seedAccount();
    const ref: MailboxRef = { workspaceId: 'ws_parity_repair', accountId, clerkOrgId: 'org_parity' };

    const state = createSqliteDurableObjectState();
    const object = new MailboxStoreObject(state, testEnv());

    const missingId = generateId('mmsg');
    await seedPgMessage(accountId, missingId, { labels: ['INBOX', 'STARRED'] });

    const diffId = generateId('mmsg');
    await seedPgMessage(accountId, diffId, { labels: ['INBOX', 'STARRED'] });
    await object.apply(ref, { kind: 'ingest', message: makeIngest(diffId, { labels: ['INBOX'] }) });

    const extraId = generateId('mmsg');
    await object.apply(ref, { kind: 'ingest', message: makeIngest(extraId, { labels: ['INBOX'] }) });

    const first = await object.runParity(ref, { repair: true });
    expect(first.missing.sort()).toEqual([missingId].sort());
    expect(first.different.map((d) => d.id)).toEqual([diffId]);
    expect(first.extra).toEqual([extraId]);

    // Repaired rows now exist / match; the extra (object-only) row is left
    // alone — repair never deletes object-ahead-of-Postgres rows (design:
    // that direction is `pg_drift`, not this one).
    const repairedMissing = await object.getMessage(ref, missingId);
    expect(repairedMissing?.labels?.slice().sort()).toEqual(['INBOX', 'STARRED']);
    const repairedDiff = await object.getMessage(ref, diffId);
    expect(repairedDiff?.labels?.slice().sort()).toEqual(['INBOX', 'STARRED']);
    expect(await object.getMessage(ref, extraId)).not.toBeNull();

    const second = await object.runParity(ref, {});
    expect(second.missing).toEqual([]);
    expect(second.different).toEqual([]);
    expect(second.extra).toEqual([extraId]);
  });

  it('pages across multiple rounds (maxRows) and resumes from the returned cursor', async () => {
    const accountId = await seedAccount();
    const ref: MailboxRef = { workspaceId: 'ws_parity_paged', accountId, clerkOrgId: 'org_parity' };

    const state = createSqliteDurableObjectState();
    const object = new MailboxStoreObject(state, testEnv());

    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = generateId('mmsg');
      ids.push(id);
      // eslint-disable-next-line no-await-in-loop -- small fixed seed set
      await seedPgMessage(accountId, id, { labels: ['INBOX'] });
      // eslint-disable-next-line no-await-in-loop
      await object.apply(ref, { kind: 'ingest', message: makeIngest(id, { labels: ['INBOX'] }) });
    }

    const first = await object.runParity(ref, { maxRows: 2 });
    expect(first.done).toBe(false);
    expect(first.cursor).not.toBeNull();

    let report = first;
    let rounds = 1;
    while (!report.done && rounds < 10) {
      // eslint-disable-next-line no-await-in-loop -- each round depends on the previous one's cursor
      report = await object.runParity(ref, { maxRows: 2, cursor: report.cursor });
      rounds++;
    }
    expect(report.done).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.extra).toEqual([]);
    expect(report.different).toEqual([]);
  });
});
