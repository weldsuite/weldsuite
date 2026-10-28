/**
 * Object-mode tests for /api/mail-messages/* (design task D2's object-mode
 * coverage): the route code is mode-agnostic (it only calls `store`/`access`
 * and branches on `mode` for the 403-vs-404 distinction), so these drive the
 * REAL `getWorkspaceMail` factory with `FLAGSHIP` pinned to `object` and the
 * C2 fakes (`@weldsuite/mail-domain/store/object/testing/fake-env`) for
 * `MAILBOX_STORE`/`MAIL_INDEX`, rather than hand-mocking the route's own
 * seam — the same "fakes run the real `MailboxStoreObject` class" approach
 * `store/object/*.test.ts` and `cron/snooze-sweep.test.ts`'s own object-mode
 * test use.
 *
 * In object mode, the mailbox object is the source of truth for its own
 * mailbox: a message must be `ingest`ed into the fake stub directly (there is
 * nothing to backfill from here), while `mail_accounts` rows still live in
 * Postgres (the KV directory build's source, design §6).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mailMessagesRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';
import { createFakeMailboxNamespace, createFakeMailIndexEnv } from '@weldsuite/mail-domain/store/object/testing/fake-env';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { createMemoryKv, createFixedModeFlagship } from '../../lib/testing/mail-object-mode';
import { __resetMailRouterStateForTests } from '@weldsuite/mail-domain/store';
import { __resetMailStoreModeCacheForTests } from '@weldsuite/mail-domain/store/mode';
import type { IngestMessage, MailboxRef } from '@weldsuite/mail-domain/store';
import type { Env, Variables } from '../../types';

const { mailAccounts, workspaceMembers } = schema;

const USER = 'user_1';
const STRANGER = 'user_stranger';
const WORKSPACE_ID = 'ws_object_mode';
const ORG_ID = 'org_object_mode';

let db: Database;
let accountId: string;
let privateAccountId: string;

function makeIngest(overrides: Partial<IngestMessage> = {}): IngestMessage {
  const id = overrides.id ?? generateId('mmsg');
  return {
    id,
    source: 'inbound',
    rfcMessageId: `${id}@test.dev`,
    threadId: null,
    from: { email: 'sender@example.com', name: 'Sender' },
    to: [{ email: 'me@test.dev' }],
    subject: 'Object mode test',
    preview: 'preview',
    sentAt: Date.now(),
    receivedAt: Date.now(),
    createdAt: Date.now(),
    isRead: false,
    labels: ['INBOX'],
    isSpam: false,
    isReply: false,
    attachments: [],
    ...overrides,
  };
}

async function ingest(mailbox: ReturnType<typeof createFakeMailboxNamespace>, ref: MailboxRef, message: IngestMessage) {
  const ns = mailbox.namespace.jurisdiction('eu');
  const stub = ns.get(ns.idFromName(`mbx:${ref.workspaceId}:${ref.accountId}`));
  await stub.apply(ref, { kind: 'ingest', message }, message.sentAt);
}

function makeApp(
  userId: string,
  mailbox: ReturnType<typeof createFakeMailboxNamespace>,
  mailIndex: ReturnType<typeof createFakeMailIndexEnv> = createFakeMailIndexEnv(),
) {
  return createTestApp<Env, Variables>('/api/mail-messages', mailMessagesRoutes, {
    context: {
      userId,
      tenantDb: db,
      workspaceId: WORKSPACE_ID,
      clerkOrgId: ORG_ID,
      permissions: permissions('messages:read', 'messages:update'),
    },
    env: {
      FLAGSHIP: createFixedModeFlagship('object') as unknown as Env['FLAGSHIP'],
      WORKSPACE_CACHE: createMemoryKv(),
      MAILBOX_STORE: mailbox.namespace,
      ...mailIndex,
      // A real (if unrelated) in-memory bucket — `ObjectMailboxStore.getMessage`
      // reads bodies from R2 directly (bypassing the RPC), so it needs a working
      // `.get()`, even though these tests never put a body in it.
      MAIL_STORAGE: createMemoryR2() as unknown as Env['MAIL_STORAGE'],
    } as Partial<Env>,
  });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(workspaceMembers).values({ id: generateId('wm'), userId: USER, email: `${USER}@test.dev`, role: 'MEMBER' } as typeof workspaceMembers.$inferInsert);
  await db.insert(workspaceMembers).values({ id: generateId('wm'), userId: STRANGER, email: `${STRANGER}@test.dev`, role: 'MEMBER' } as typeof workspaceMembers.$inferInsert);

  accountId = generateId('mail');
  await db.insert(mailAccounts).values({ id: accountId, name: 'Shared', email: `${accountId}@test.dev`, isShared: true });

  privateAccountId = generateId('mail');
  await db.insert(mailAccounts).values({ id: privateAccountId, name: 'Private', email: `${privateAccountId}@test.dev`, isShared: false, assignedUserIds: [] });
}, 60_000);

beforeEach(() => {
  __resetMailRouterStateForTests();
  __resetMailStoreModeCacheForTests();
});

afterEach(() => {
  __resetMailRouterStateForTests();
  __resetMailStoreModeCacheForTests();
});

describe('object mode: GET /api/mail-messages', () => {
  it('lists a message ingested straight into the mailbox object, with cursor paging', async () => {
    const mailbox = createFakeMailboxNamespace();
    const ref: MailboxRef = { workspaceId: WORKSPACE_ID, accountId, clerkOrgId: ORG_ID };
    const older = makeIngest({ sentAt: 1_000 });
    const newer = makeIngest({ sentAt: 2_000 });
    await ingest(mailbox, ref, older);
    await ingest(mailbox, ref, newer);

    const { request } = makeApp(USER, mailbox);
    const page1 = await request(`/api/mail-messages?accountId=${accountId}&limit=1`);
    expect(page1.status).toBe(200);
    const body1 = (await page1.json()) as { data: Array<{ id: string }>; pagination: { hasMore: boolean; cursor: string | null } };
    expect(body1.data).toHaveLength(1);
    expect(body1.data[0]!.id).toBe(newer.id);
    expect(body1.pagination.hasMore).toBe(true);
    expect(body1.pagination.cursor).toBe(newer.id);

    const page2 = await request(`/api/mail-messages?accountId=${accountId}&limit=1&cursor=${body1.pagination.cursor}`);
    const body2 = (await page2.json()) as { data: Array<{ id: string }>; pagination: { hasMore: boolean } };
    expect(body2.data).toHaveLength(1);
    expect(body2.data[0]!.id).toBe(older.id);
    expect(body2.pagination.hasMore).toBe(false);
  });

  it('finds the counterparty across mailboxes through messagesByCounterparty', async () => {
    const mailbox = createFakeMailboxNamespace();
    const ref: MailboxRef = { workspaceId: WORKSPACE_ID, accountId, clerkOrgId: ORG_ID };
    const message = makeIngest({ from: { email: 'vip@example.com', name: 'VIP' } });
    await ingest(mailbox, ref, message);
    // The ledger's address index narrows which mailboxes `messagesByCounterparty`
    // even asks (design §5) — tell the fake index this address lives in `accountId`.
    const mailIndex = createFakeMailIndexEnv({ addressToMailboxes: new Map([['vip@example.com', [accountId]]]) });

    const { request } = makeApp(USER, mailbox, mailIndex);
    const res = await request('/api/mail-messages?counterparty=vip@example.com');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((m) => m.id)).toContain(message.id);
  });
});

describe('object mode: GET /api/mail-messages/:id — 404 instead of 403', () => {
  it('answers 404 for a message in a mailbox the caller cannot open (today it is 403 in postgres mode)', async () => {
    const mailbox = createFakeMailboxNamespace();
    const ref: MailboxRef = { workspaceId: WORKSPACE_ID, accountId: privateAccountId, clerkOrgId: ORG_ID };
    const message = makeIngest();
    await ingest(mailbox, ref, message);

    const { request } = makeApp(STRANGER, mailbox);
    const res = await request(`/api/mail-messages/${message.id}`);
    expect(res.status).toBe(404);
  });

  it('locates a message directly via the accountId hint, without a fan-out', async () => {
    const mailbox = createFakeMailboxNamespace();
    const ref: MailboxRef = { workspaceId: WORKSPACE_ID, accountId, clerkOrgId: ORG_ID };
    const message = makeIngest();
    await ingest(mailbox, ref, message);

    const { request } = makeApp(USER, mailbox);
    const res = await request(`/api/mail-messages/${message.id}?accountId=${accountId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBe(message.id);
  });

  it('still finds a message without the hint, by fanning out to every accessible mailbox', async () => {
    const mailbox = createFakeMailboxNamespace();
    const ref: MailboxRef = { workspaceId: WORKSPACE_ID, accountId, clerkOrgId: ORG_ID };
    const message = makeIngest();
    await ingest(mailbox, ref, message);

    const { request } = makeApp(USER, mailbox);
    const res = await request(`/api/mail-messages/${message.id}`);
    expect(res.status).toBe(200);
  });
});
