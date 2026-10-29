/**
 * Backfill/catch-up (design doc §4, task C4) against a real pglite Postgres
 * and a real `MailboxStoreObject` over the `durable-sqlite` fake: resume
 * after a simulated eviction, an idempotent forced re-run, bodies copied to
 * R2, `ready` flipping only once catch-up finishes, and the catch-up LWW
 * merge including a clock-skew case.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { createSqliteDurableObjectState, fireAlarm } from '@weldsuite/worker-kit/testing/durable-sqlite';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { MailboxStoreObject, type MailboxStoreObjectEnv } from './mailbox-object';
import type { BackfillState } from './backfill';
import type { MailboxRef } from '../store/types';

const { mailAccounts, mailDrafts, mailMessages, mailSubscriptions } = schema;

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

const REF: MailboxRef = { workspaceId: 'ws_backfill', accountId: 'acc_unset', clerkOrgId: 'org_backfill' };

async function seedAccount(): Promise<string> {
  const id = generateId('mail');
  await db.insert(mailAccounts).values({ id, name: 'Backfill test', email: `${id}@test.dev`, isShared: true });
  return id;
}

interface SeedMessageOptions {
  threadId?: string;
  labels?: string[];
  isRead?: boolean;
  isStarred?: boolean;
  textBody?: string;
  htmlBody?: string;
  sentDate?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  source?: 'inbound' | 'sent';
  deletedAt?: Date;
}

async function seedMessage(accountId: string, opts: SeedMessageOptions = {}): Promise<string> {
  const id = generateId('mmsg');
  await db.insert(mailMessages).values({
    id,
    accountId,
    threadId: opts.threadId ?? `thread_${id}`,
    messageId: `<${id}@test.dev>`,
    from: { email: 'sender@example.com', name: 'Sender' },
    to: [{ email: 'me@test.dev' }],
    subject: `Subject ${id}`,
    sentDate: opts.sentDate ?? new Date(),
    labels: opts.labels ?? ['INBOX'],
    isRead: opts.isRead ?? false,
    isStarred: opts.isStarred ?? false,
    textBody: opts.textBody,
    htmlBody: opts.htmlBody,
    source: opts.source ?? 'inbound',
    createdAt: opts.createdAt,
    updatedAt: opts.updatedAt,
    deletedAt: opts.deletedAt,
  });
  return id;
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

/** Fires the alarm until no alarm is pending or `maxTicks` is hit — mirrors how a real Durable Object would be woken repeatedly by Cloudflare. */
async function fireAlarmsUntilIdle(state: Awaited<ReturnType<typeof createSqliteDurableObjectState>>, object: MailboxStoreObject, maxTicks = 500): Promise<number> {
  let ticks = 0;
  while (ticks < maxTicks) {
    const ran = await fireAlarm(state, object);
    if (!ran) break;
    ticks++;
  }
  return ticks;
}

async function runBackfillToDone(object: MailboxStoreObject, state: Awaited<ReturnType<typeof createSqliteDurableObjectState>>, ref: MailboxRef): Promise<BackfillState> {
  await object.startBackfill(ref, { source: 'test' });
  await fireAlarmsUntilIdle(state, object);
  return object.backfillStatus(ref);
}

describe('backfill: initial pass + catch-up', () => {
  it('copies subscriptions, drafts and messages (with bodies to R2), then reaches done', async () => {
    const accountId = await seedAccount();
    const ref: MailboxRef = { ...REF, accountId };

    const m1 = await seedMessage(accountId, { labels: ['INBOX', 'STARRED'], isStarred: true, textBody: 'plain body', htmlBody: '<p>html body</p>' });
    await seedMessage(accountId, { labels: ['SENT'], source: 'sent', isRead: true });

    const draftId = generateId('draft');
    await db.insert(mailDrafts).values({ id: draftId, accountId, subject: 'Draft subject', body: 'draft body' });

    await db.insert(mailSubscriptions).values({
      id: generateId('msub'),
      accountId,
      senderEmail: 'newsletter@example.com',
      messageCount: 3,
      firstReceivedAt: new Date(Date.now() - 86_400_000),
      lastReceivedAt: new Date(),
    });

    const bucket = createMemoryR2();
    const env = testEnv({ MAIL_STORAGE: bucket });
    const state = createSqliteDurableObjectState();
    const object = new MailboxStoreObject(state, env);

    const finalState = await runBackfillToDone(object, state, ref);
    expect(finalState.state).toBe('done');
    expect(finalState.copied.messages).toBe(2);
    expect(finalState.copied.drafts).toBe(1);
    expect(finalState.copied.subscriptions).toBe(1);

    const status = await object.status(ref);
    expect(status.ready).toBe(true);
    expect(status.counts.messages).toBe(2);
    expect(status.counts.drafts).toBe(1);
    expect(status.counts.subscriptions).toBe(1);

    const m1Record = await object.getMessage(ref, m1);
    expect(m1Record?.labels?.slice().sort()).toEqual(['INBOX', 'STARRED']);
    expect(m1Record?.isStarred).toBe(true);

    expect(await bucket.get(`mail/${ref.workspaceId}/${accountId}/${m1}/body.html`)).not.toBeNull();
    expect(await bucket.get(`mail/${ref.workspaceId}/${accountId}/${m1}/body.txt`)).not.toBeNull();

    const draft = await object.getDraft(ref, draftId);
    expect(draft?.subject).toBe('Draft subject');

    const subs = await object.listSubscriptions(ref, {});
    expect(subs.map((s) => s.senderEmail)).toEqual(['newsletter@example.com']);
  }, 30_000);

  it('resumes correctly after a simulated eviction mid-backfill', async () => {
    const accountId = await seedAccount();
    const ref: MailboxRef = { ...REF, accountId };
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential seeding keeps createdAt strictly increasing for stable (createdAt,id) ordering
      await seedMessage(accountId, { sentDate: new Date(Date.now() + i) });
    }

    const bucket = createMemoryR2();
    const state = createSqliteDurableObjectState();
    let object = new MailboxStoreObject(state, testEnv({ MAIL_STORAGE: bucket }));

    await object.startBackfill(ref, { source: 'test' });
    // Only partway: one tick is enough to land the subscriptions/drafts
    // phases (both empty here) and at most one page of messages.
    await fireAlarm(state, object);

    const midway = await object.backfillStatus(ref);
    expect(midway.state === 'running' || midway.state === 'catchup').toBe(true);

    // Simulate the object being evicted and recreated: a FRESH class
    // instance over the SAME underlying storage (the fake's `state` is the
    // durable part; only the in-memory `MailboxStoreObject` wrapper is new).
    object = new MailboxStoreObject(state, testEnv({ MAIL_STORAGE: bucket }));
    await fireAlarmsUntilIdle(state, object);

    const finalState = await object.backfillStatus(ref);
    expect(finalState.state).toBe('done');
    expect(finalState.copied.messages).toBe(5);
    const status = await object.status(ref);
    expect(status.counts.messages).toBe(5);
  }, 30_000);

  it('is idempotent on a forced re-run: no duplicate rows, same counts', async () => {
    const accountId = await seedAccount();
    const ref: MailboxRef = { ...REF, accountId };
    await seedMessage(accountId, { labels: ['INBOX'] });
    await seedMessage(accountId, { labels: ['ARCHIVE'] });

    const state = createSqliteDurableObjectState();
    const object = new MailboxStoreObject(state, testEnv());

    await runBackfillToDone(object, state, ref);
    const first = await object.status(ref);
    expect(first.counts.messages).toBe(2);

    // A plain re-run without `force` is the cheap no-op path: same
    // `finishedAt`, proof no re-work happened (an unrelated outbox retry
    // backoff may still legitimately hold the alarm open — see outbox.ts —
    // so "no alarm pending" isn't the right thing to assert here).
    const done = await object.backfillStatus(ref);
    const cheap = await object.startBackfill(ref, { source: 'test' });
    expect(cheap.state).toBe('done');
    expect(cheap.finishedAt).toBe(done.finishedAt);

    // `force: true` genuinely restarts the pipeline; re-ingesting the same
    // Postgres rows must not create duplicates (`ingest` is insert-if-absent).
    await object.startBackfill(ref, { source: 'test', force: true });
    await fireAlarmsUntilIdle(state, object);
    const second = await object.status(ref);
    expect(second.counts.messages).toBe(2);
  }, 30_000);

  it('startBackfill is a cheap no-op while a run is already in progress', async () => {
    const accountId = await seedAccount();
    const ref: MailboxRef = { ...REF, accountId };
    await seedMessage(accountId);

    const state = createSqliteDurableObjectState();
    const object = new MailboxStoreObject(state, testEnv());

    const first = await object.startBackfill(ref, { source: 'test' });
    expect(first.state).toBe('running');
    const second = await object.startBackfill(ref, { source: 'test' });
    // Same `startedAt` — proof the second call didn't reset the run.
    expect(second.startedAt).toBe(first.startedAt);
  });

  it('ready stays false until catch-up finishes, independent of how many messages phase alone copied', async () => {
    const accountId = await seedAccount();
    const ref: MailboxRef = { ...REF, accountId };
    await seedMessage(accountId);

    const state = createSqliteDurableObjectState();
    const object = new MailboxStoreObject(state, testEnv());
    await object.startBackfill(ref, { source: 'test' });

    let sawNotReady = false;
    for (let i = 0; i < 20; i++) {
      // eslint-disable-next-line no-await-in-loop -- driving the alarm one tick at a time to observe the ready transition
      const ran = await fireAlarm(state, object);
      if (!ran) break;
      // eslint-disable-next-line no-await-in-loop
      const status = await object.status(ref);
      if (!status.ready) sawNotReady = true;
      // eslint-disable-next-line no-await-in-loop
      const backfill = await object.backfillStatus(ref);
      if (backfill.state === 'done') break;
    }
    expect(sawNotReady).toBe(true);
    expect((await object.status(ref)).ready).toBe(true);
  });

  it('catch-up applies a genuine Postgres-side change made after the initial pass', async () => {
    const accountId = await seedAccount();
    const ref: MailboxRef = { ...REF, accountId };
    const id = await seedMessage(accountId, { isRead: false });

    const state = createSqliteDurableObjectState();
    const object = new MailboxStoreObject(state, testEnv());
    await object.startBackfill(ref, { source: 'test' });

    // Drive it to exactly the 'catchup' phase (past 'messages') without
    // necessarily finishing — then make a real Postgres edit and let it land.
    for (let i = 0; i < 20; i++) {
      // eslint-disable-next-line no-await-in-loop
      const ran = await fireAlarm(state, object);
      if (!ran) break;
      // eslint-disable-next-line no-await-in-loop
      const backfill = await object.backfillStatus(ref);
      if (backfill.phase === 'catchup' || backfill.state === 'done') break;
    }

    await db.update(mailMessages).set({ isRead: true, updatedAt: new Date() }).where(eq(mailMessages.id, id));

    await fireAlarmsUntilIdle(state, object);
    expect((await object.backfillStatus(ref)).state).toBe('done');
    const record = await object.getMessage(ref, id);
    expect(record?.isRead).toBe(true);
  }, 30_000);

  it('catch-up LWW merge: a live write already ahead of Postgres is not reverted (clock skew)', async () => {
    const accountId = await seedAccount();
    const ref: MailboxRef = { ...REF, accountId };
    const id = await seedMessage(accountId, { isRead: false });

    const state = createSqliteDurableObjectState();
    const object = new MailboxStoreObject(state, testEnv());
    await object.startBackfill(ref, { source: 'test' });

    // Drive the alarm one tick at a time until the message has actually been
    // ingested (subscriptions/drafts are empty and each cost their own tick
    // first) — polling for the real signal instead of guessing a tick count.
    for (let i = 0; i < 20; i++) {
      // eslint-disable-next-line no-await-in-loop
      const ran = await fireAlarm(state, object);
      if (!ran) break;
      // eslint-disable-next-line no-await-in-loop
      if (await object.getMessage(ref, id)) break;
    }
    expect(await object.getMessage(ref, id)).not.toBeNull();

    // A "live" dual-write marks the message read in the object directly, far
    // in the future relative to anything Postgres will claim below.
    const farFuture = Date.now() + 10 * 60_000;
    await object.apply(ref, { kind: 'flags', ids: [id], patch: { isRead: true }, semantics: 'single' }, farFuture);
    expect((await object.getMessage(ref, id))?.isRead).toBe(true);

    // Postgres's own `updated_at` is bumped (so catch-up's `updated_at >=
    // since` window picks the row back up) but to a time BEFORE the object's
    // own write above, and the row's content is still unread — simulating a
    // stale write that is only now reaching catch-up under clock skew.
    const staleAt = new Date(farFuture - 5 * 60_000);
    await db.update(mailMessages).set({ isRead: false, updatedAt: staleAt }).where(eq(mailMessages.id, id));

    await fireAlarmsUntilIdle(state, object);
    expect((await object.backfillStatus(ref)).state).toBe('done');

    // The object's newer state must win: still read, not reverted to false.
    expect((await object.getMessage(ref, id))?.isRead).toBe(true);
  }, 30_000);
});
