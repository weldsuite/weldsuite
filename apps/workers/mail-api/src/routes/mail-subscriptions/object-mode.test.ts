/**
 * `object-only`-mode test for `POST /api/mail-subscriptions/:id/unsubscribe`
 * (design task D2's object-mode coverage, mirrors
 * `mail-messages/object-mode.test.ts`'s own pattern): the route resolves the
 * real `getWorkspaceMail` factory with `FLAGSHIP` pinned to `object-only` and
 * the C2 fakes (`@weldsuite/mail-domain/store/object/testing/fake-env`) for
 * `MAILBOX_STORE`, rather than hand-mocking the route's own seam.
 *
 * `object-only` never writes `mail_subscriptions` to Postgres — a
 * `List-Unsubscribe` message is ingested straight into the fake mailbox
 * stub and scanned there (`POST /scan`, which already worked through the
 * store), so the id `/:id/unsubscribe` has to resolve has zero Postgres
 * `mail_subscriptions` rows behind it. This proves `locateSubscription`'s
 * object-mode fallback (fan out over the caller's accessible mailboxes via
 * `MailboxStore.getSubscription`) finds it anyway.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mailSubscriptionsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';
import { createFakeMailboxNamespace } from '@weldsuite/mail-domain/store/object/testing/fake-env';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { putRawMime } from '@weldsuite/mail-domain/store/bodies';
import { createMemoryKv, createFixedModeFlagship } from '@weldsuite/mail-domain/store/testing/object-mode';
import { __resetMailRouterStateForTests } from '@weldsuite/mail-domain/store';
import { __resetMailStoreModeCacheForTests } from '@weldsuite/mail-domain/store/mode';
import type { IngestMessage, MailboxRef } from '@weldsuite/mail-domain/store';
import type { Env, Variables } from '../../types';

const { mailAccounts, mailSubscriptions, workspaceMembers } = schema;

const USER = 'user_1';
const STRANGER = 'user_stranger';
const WORKSPACE_ID = 'ws_subs_object_only';
const ORG_ID = 'org_subs_object_only';

let db: Database;
let accountId: string;
let bucket: R2Bucket;

async function ingest(mailbox: ReturnType<typeof createFakeMailboxNamespace>, ref: MailboxRef, message: IngestMessage) {
  const ns = mailbox.namespace.jurisdiction('eu');
  const stub = ns.get(ns.idFromName(`mbx:${ref.workspaceId}:${ref.accountId}`));
  await stub.apply(ref, { kind: 'ingest', message }, message.sentAt);
}

function makeApp(userId: string, mailbox: ReturnType<typeof createFakeMailboxNamespace>) {
  return createTestApp<Env, Variables>('/api/mail-subscriptions', mailSubscriptionsRoutes, {
    context: {
      userId,
      tenantDb: db,
      workspaceId: WORKSPACE_ID,
      clerkOrgId: ORG_ID,
      permissions: permissions('messages:read', 'messages:update'),
    },
    env: {
      FLAGSHIP: createFixedModeFlagship('object-only') as unknown as Env['FLAGSHIP'],
      WORKSPACE_CACHE: createMemoryKv(),
      MAILBOX_STORE: mailbox.namespace,
      MAIL_STORAGE: bucket as unknown as Env['MAIL_STORAGE'],
    } as Partial<Env>,
  });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(workspaceMembers).values({ id: generateId('wm'), userId: USER, email: `${USER}@test.dev`, role: 'MEMBER' } as typeof workspaceMembers.$inferInsert);
  await db.insert(workspaceMembers).values({ id: generateId('wm'), userId: STRANGER, email: `${STRANGER}@test.dev`, role: 'MEMBER' } as typeof workspaceMembers.$inferInsert);

  accountId = generateId('mail');
  await db.insert(mailAccounts).values({ id: accountId, name: 'Shared', email: `${accountId}@test.dev`, isShared: true });
}, 60_000);

beforeEach(() => {
  __resetMailRouterStateForTests();
  __resetMailStoreModeCacheForTests();
});

afterEach(() => {
  __resetMailRouterStateForTests();
  __resetMailStoreModeCacheForTests();
});

describe('object-only mode: POST /api/mail-subscriptions/:id/unsubscribe', () => {
  it('locates the subscription by fanning out over accessible mailboxes, with zero Postgres rows', async () => {
    bucket = createMemoryR2();
    const mailbox = createFakeMailboxNamespace();
    const ref: MailboxRef = { workspaceId: WORKSPACE_ID, accountId, clerkOrgId: ORG_ID };

    const messageId = generateId('mmsg');
    const sentAt = Date.now() - 86_400_000;
    const ingestMessage: IngestMessage = {
      id: messageId,
      source: 'inbound',
      rfcMessageId: `<${messageId}@test.dev>`,
      threadId: null,
      from: { email: 'news@shop.com', name: 'Shop' },
      to: [{ email: 'me@test.dev' }],
      subject: 'Weekly deals',
      preview: null,
      sentAt,
      receivedAt: sentAt,
      createdAt: sentAt,
      isRead: false,
      labels: ['INBOX'],
      isSpam: false,
      isReply: false,
      attachments: [],
    };
    await ingest(mailbox, ref, ingestMessage);
    await putRawMime(
      bucket,
      { workspaceId: WORKSPACE_ID, accountId, messageId },
      new TextEncoder().encode('From: news@shop.com\r\nList-Unsubscribe: <https://shop.com/u>\r\n\r\nbody text'),
    );

    const { request } = makeApp(USER, mailbox);

    const scanRes = await request('/api/mail-subscriptions/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId }),
    });
    expect(scanRes.status).toBe(200);

    const listRes = await request(`/api/mail-subscriptions?accountId=${accountId}`);
    const listJson = (await listRes.json()) as { data: Array<{ id: string; senderEmail: string }> };
    expect(listJson.data).toHaveLength(1);
    const subscriptionId = listJson.data[0]!.id;

    // Zero Postgres `mail_subscriptions` rows behind that id — object-only
    // never writes one.
    const pgRows = await db.select({ id: mailSubscriptions.id }).from(mailSubscriptions);
    expect(pgRows).toHaveLength(0);

    const unsubRes = await request(`/api/mail-subscriptions/${subscriptionId}/unsubscribe`, { method: 'POST' });
    expect(unsubRes.status).toBe(200);
    const unsubJson = (await unsubRes.json()) as { data: { subscription: { status: string }; method: string } };
    expect(unsubJson.data.method).toBe('link');
    expect(unsubJson.data.subscription.status).toBe('unsubscribed');
  });

  it('answers 404 for an id no accessible mailbox holds', async () => {
    bucket = createMemoryR2();
    const mailbox = createFakeMailboxNamespace();
    const { request } = makeApp(STRANGER, mailbox);
    const res = await request('/api/mail-subscriptions/msub_missing/unsubscribe', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
