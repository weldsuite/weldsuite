/**
 * Reverse sync (design doc §4, Risks: "rollback from object/object-only
 * requires reverse sync"; task C4): after a run of object-only writes
 * (messages, drafts, subscriptions), `reverseSync` makes Postgres match again
 * — inserting object-only rows (with bodies pulled from R2) and updating
 * already-existing rows' mutable fields — and pages/resumes over a large
 * message set via its own cursor.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { createSqliteDurableObjectState } from '@weldsuite/worker-kit/testing/durable-sqlite';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { putMessageBodies } from '../store/bodies';
import { MailboxStoreObject, type MailboxStoreObjectEnv } from './mailbox-object';
import type { IngestMessage, MailboxRef } from '../store/types';

const { mailAccounts, mailDrafts, mailMessages, mailSubscriptions } = schema;

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

async function seedAccount(): Promise<string> {
  const id = generateId('mail');
  await db.insert(mailAccounts).values({ id, name: 'Reverse sync test', email: `${id}@test.dev`, isShared: true });
  return id;
}

function testEnv(bucket: R2Bucket, overrides: Partial<MailboxStoreObjectEnv> = {}): MailboxStoreObjectEnv {
  return {
    DATABASE_URL_MASTER: 'postgres://unused',
    WORKSPACE_CACHE: {} as KVNamespace,
    NEON_API_KEY: 'unused',
    MAIL_STORAGE: bucket,
    tenantDbReader: async () => db,
    ...overrides,
  };
}

function makeIngest(id: string, overrides: Partial<IngestMessage> = {}): IngestMessage {
  return {
    id,
    source: 'inbound',
    rfcMessageId: `<${id}@test.dev>`,
    threadId: `thread_${id}`,
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

describe('reverse sync', () => {
  it('inserts object-only messages (with bodies from R2) and updates already-shared rows', async () => {
    const accountId = await seedAccount();
    const ref: MailboxRef = { workspaceId: 'ws_reverse', accountId, clerkOrgId: 'org_reverse' };
    const since = Date.now() - 60_000;

    const bucket = createMemoryR2();
    const state = createSqliteDurableObjectState();
    const object = new MailboxStoreObject(state, testEnv(bucket));

    // M1: a message that exists in BOTH stores (created back when Postgres
    // was primary), then had its read state flipped by an object-primary
    // write that never reached Postgres.
    const m1 = generateId('mmsg');
    await db.insert(mailMessages).values({
      id: m1,
      accountId,
      threadId: `thread_${m1}`,
      messageId: `<${m1}@test.dev>`,
      from: { email: 'sender@example.com' },
      to: [{ email: 'me@test.dev' }],
      subject: 'Shared message',
      sentDate: new Date(),
      labels: ['INBOX'],
      isRead: false,
    });
    await object.apply(ref, { kind: 'ingest', message: makeIngest(m1, { labels: ['INBOX'], isRead: false }) });
    await object.apply(ref, { kind: 'flags', ids: [m1], patch: { isRead: true }, semantics: 'single' });

    // M2: object-only (never written to Postgres at all), with a real body.
    const m2 = generateId('mmsg');
    await putMessageBodies(bucket, { workspaceId: ref.workspaceId, accountId, messageId: m2 }, { html: '<p>object only</p>', text: 'object only' });
    await object.apply(ref, {
      kind: 'ingest',
      message: makeIngest(m2, { labels: ['INBOX', 'STARRED'], bodies: { html: true, text: true, raw: false } }),
    });

    // A draft and a subscription, also object-only.
    const draftId = generateId('draft');
    await object.apply(ref, { kind: 'draft.create', draft: { id: draftId, accountId, subject: 'Object-only draft', body: 'draft body' } });
    await object.apply(ref, {
      kind: 'subscription.upsert',
      values: [
        {
          senderEmail: 'list@example.com',
          senderName: 'List',
          senderDomain: 'example.com',
          listId: null,
          unsubscribeUrl: null,
          unsubscribeMailto: null,
          oneClick: false,
          messageCount: 2,
          lastSubject: 'Hi',
          firstReceivedAt: new Date(Date.now() - 86_400_000),
          lastReceivedAt: new Date(),
        },
      ],
    });

    const report = await object.reverseSync(ref, { since });
    expect(report.done).toBe(true);
    expect(report.counts.messagesInserted).toBe(1);
    expect(report.counts.messagesUpdated).toBe(1);
    expect(report.counts.draftsSynced).toBe(1);
    expect(report.counts.subscriptionsSynced).toBe(1);

    const [pgM1] = await db.select().from(mailMessages).where(eq(mailMessages.id, m1));
    expect(pgM1?.isRead).toBe(true);

    const [pgM2] = await db.select().from(mailMessages).where(eq(mailMessages.id, m2));
    expect(pgM2).toBeDefined();
    expect(pgM2?.labels?.slice().sort()).toEqual(['INBOX', 'STARRED']);
    expect(pgM2?.htmlBody).toBe('<p>object only</p>');
    expect(pgM2?.textBody).toBe('object only');

    const [pgDraft] = await db.select().from(mailDrafts).where(eq(mailDrafts.id, draftId));
    expect(pgDraft?.subject).toBe('Object-only draft');

    const [pgSub] = await db.select().from(mailSubscriptions).where(eq(mailSubscriptions.senderEmail, 'list@example.com'));
    expect(pgSub?.messageCount).toBe(2);
  }, 30_000);

  it('syncs a soft-deleted object row into Postgres', async () => {
    const accountId = await seedAccount();
    const ref: MailboxRef = { workspaceId: 'ws_reverse_delete', accountId, clerkOrgId: 'org_reverse' };
    const since = Date.now() - 60_000;

    const state = createSqliteDurableObjectState();
    const object = new MailboxStoreObject(state, testEnv(createMemoryR2()));

    const id = generateId('mmsg');
    await object.apply(ref, { kind: 'ingest', message: makeIngest(id) });
    await object.apply(ref, { kind: 'delete', ids: [id], hard: false });

    const report = await object.reverseSync(ref, { since });
    expect(report.counts.messagesInserted).toBe(1);

    const [pgRow] = await db.select().from(mailMessages).where(eq(mailMessages.id, id));
    expect(pgRow?.deletedAt).not.toBeNull();
  });

  it('pages across multiple rounds and resumes from the returned cursor', async () => {
    const accountId = await seedAccount();
    const ref: MailboxRef = { workspaceId: 'ws_reverse_paged', accountId, clerkOrgId: 'org_reverse' };
    const since = Date.now() - 60_000;

    const state = createSqliteDurableObjectState();
    const object = new MailboxStoreObject(state, testEnv(createMemoryR2()));

    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = generateId('mmsg');
      ids.push(id);
      // eslint-disable-next-line no-await-in-loop -- small fixed seed set
      await object.apply(ref, { kind: 'ingest', message: makeIngest(id) });
    }

    const first = await object.reverseSync(ref, { since, maxRows: 2 });
    expect(first.done).toBe(false);
    expect(first.cursor).not.toBeNull();
    expect(first.counts.messagesInserted).toBe(2);

    let report = first;
    let totalInserted = report.counts.messagesInserted;
    let rounds = 1;
    while (!report.done && rounds < 10) {
      // eslint-disable-next-line no-await-in-loop -- each round depends on the previous one's cursor
      report = await object.reverseSync(ref, { since, maxRows: 2, cursor: report.cursor });
      totalInserted += report.counts.messagesInserted;
      rounds++;
    }
    expect(report.done).toBe(true);
    expect(totalInserted).toBe(5);

    const rows = await db.select({ id: mailMessages.id }).from(mailMessages).where(eq(mailMessages.accountId, accountId));
    expect(rows.map((r) => r.id).sort()).toEqual([...ids].sort());
  }, 30_000);
});
