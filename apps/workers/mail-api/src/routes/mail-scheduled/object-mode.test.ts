/**
 * `object-only`-mode test for `GET /api/mail-scheduled` (design task D2's
 * object-mode coverage, mirrors `mail-messages/object-mode.test.ts`'s own
 * pattern): the route resolves the real `getWorkspaceMail` factory with
 * `FLAGSHIP` pinned to `object-only` and the C2 fakes
 * (`@weldsuite/mail-domain/store/object/testing/fake-env`) for
 * `MAILBOX_STORE`, rather than hand-mocking the route's own seam.
 *
 * `object-only` never writes `mail_messages` at all — a scheduled message
 * here is `ingest`ed straight into the fake mailbox stub, with zero Postgres
 * mail rows, proving `GET /api/mail-scheduled` (`services/mail/scheduled.ts`'s
 * `listScheduled`) answers through the store instead of the
 * previously-direct `mail_messages` query that this mode never populates.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mailScheduledRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';
import { createFakeMailboxNamespace } from '@weldsuite/mail-domain/store/object/testing/fake-env';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { createMemoryKv, createFixedModeFlagship } from '@weldsuite/mail-domain/store/testing/object-mode';
import { __resetMailRouterStateForTests } from '@weldsuite/mail-domain/store';
import { __resetMailStoreModeCacheForTests } from '@weldsuite/mail-domain/store/mode';
import type { IngestMessage, MailboxRef } from '@weldsuite/mail-domain/store';
import type { Env, Variables } from '../../types';

const { mailAccounts, mailMessages, workspaceMembers } = schema;

const USER = 'user_1';
const STRANGER = 'user_stranger';
const WORKSPACE_ID = 'ws_scheduled_object_only';
const ORG_ID = 'org_scheduled_object_only';

let db: Database;
let accountId: string;
let privateAccountId: string;

function makeIngest(overrides: Partial<IngestMessage> = {}): IngestMessage {
  const id = overrides.id ?? generateId('msg');
  const now = Date.now();
  return {
    id,
    source: 'scheduled',
    rfcMessageId: `<${id}@scheduled.weldsuite.org>`,
    threadId: `<${id}@scheduled.weldsuite.org>`,
    from: { email: 'me@test.dev' },
    to: [{ email: 'rcpt@example.com' }],
    subject: 'Later',
    preview: 'Body',
    sentAt: now,
    receivedAt: null,
    createdAt: now,
    isRead: true,
    labels: ['SENT', 'SCHEDULED'],
    isSpam: false,
    isReply: false,
    sendStatus: 'scheduled',
    scheduledFor: now + 3_600_000,
    attachments: [],
    ...overrides,
  };
}

async function ingest(mailbox: ReturnType<typeof createFakeMailboxNamespace>, ref: MailboxRef, message: IngestMessage) {
  const ns = mailbox.namespace.jurisdiction('eu');
  const stub = ns.get(ns.idFromName(`mbx:${ref.workspaceId}:${ref.accountId}`));
  await stub.apply(ref, { kind: 'ingest', message }, message.sentAt);
}

function makeApp(userId: string, mailbox: ReturnType<typeof createFakeMailboxNamespace>) {
  return createTestApp<Env, Variables>('/api/mail-scheduled', mailScheduledRoutes, {
    context: {
      userId,
      tenantDb: db,
      workspaceId: WORKSPACE_ID,
      clerkOrgId: ORG_ID,
      permissions: permissions('messages:read'),
    },
    env: {
      FLAGSHIP: createFixedModeFlagship('object-only') as unknown as Env['FLAGSHIP'],
      WORKSPACE_CACHE: createMemoryKv(),
      MAILBOX_STORE: mailbox.namespace,
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

describe('object-only mode: GET /api/mail-scheduled', () => {
  it('lists a scheduled message ingested straight into the mailbox object, with zero Postgres mail rows', async () => {
    const mailbox = createFakeMailboxNamespace();
    const ref: MailboxRef = { workspaceId: WORKSPACE_ID, accountId, clerkOrgId: ORG_ID };
    const message = makeIngest();
    await ingest(mailbox, ref, message);

    // Confirm there really is nothing in Postgres for this mailbox.
    const pgRows = await db.select({ id: mailMessages.id }).from(mailMessages);
    expect(pgRows).toHaveLength(0);

    const { request } = makeApp(USER, mailbox);
    const res = await request(`/api/mail-scheduled?accountId=${accountId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((m) => m.id)).toEqual([message.id]);
  });

  it("scopes the unified list (no accountId) to the caller's accessible mailboxes, same as postgres mode", async () => {
    const mailbox = createFakeMailboxNamespace();
    const ref: MailboxRef = { workspaceId: WORKSPACE_ID, accountId: privateAccountId, clerkOrgId: ORG_ID };
    const message = makeIngest();
    await ingest(mailbox, ref, message);

    const { request } = makeApp(STRANGER, mailbox);
    const res = await request('/api/mail-scheduled');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data).toEqual([]);
  });

  it('answers 403 for an accountId the caller cannot open', async () => {
    const mailbox = createFakeMailboxNamespace();
    const { request } = makeApp(STRANGER, mailbox);
    const res = await request(`/api/mail-scheduled?accountId=${privateAccountId}`);
    expect(res.status).toBe(403);
  });
});
