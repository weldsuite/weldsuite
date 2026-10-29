/**
 * Object-mode tests for mail subscriptions' store wiring (design task D1):
 * the scan's candidate-message read and the upsert, and the unsubscribe
 * status write, all go through a real `ObjectMailboxStore` (the C2 fakes,
 * which run the real `MailboxObject` class underneath) instead of
 * `mail_messages`/`mail_subscriptions` directly. Mirrors
 * `subscriptions.test.ts`'s own scenarios (link-only sender, no network or
 * send binding needed) so the two suites read as a pair.
 */

vi.mock('cloudflare:email', () => ({
  EmailMessage: class {
    constructor(public readonly from: string, public readonly to: string, public readonly raw: string) {}
  },
}));

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { listSubscriptions, scanSubscriptions, unsubscribe } from './subscriptions';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';
import type { Env } from '../../types';
import { putRawMime } from '@weldsuite/mail-domain/store/bodies';
import { ObjectMailboxStore } from '@weldsuite/mail-domain/store/object';
import { createFakeMailboxNamespace } from '@weldsuite/mail-domain/store/object/testing/fake-env';
import type { IngestMessage, MailboxRef, MailboxStore } from '@weldsuite/mail-domain/store/types';

const WORKSPACE_ID = 'ws_subs_object';
const ORG_ID = 'org_subs_object';

let db: Database;
let bucket: R2Bucket;

function storeFor(accountId: string): MailboxStore {
  const mailbox = createFakeMailboxNamespace();
  const ref: MailboxRef = { workspaceId: WORKSPACE_ID, accountId, clerkOrgId: ORG_ID };
  return new ObjectMailboxStore({ MAILBOX_STORE: mailbox.namespace, MAIL_STORAGE: bucket }, ref);
}

async function ingestInbound(
  store: MailboxStore,
  accountId: string,
  from: string,
  rawHeaders: string,
  opts: { daysAgo?: number; isSpam?: boolean; subject?: string } = {},
): Promise<string> {
  const id = generateId('mmsg');
  const sentAt = Date.now() - (opts.daysAgo ?? 1) * 86_400_000;
  const message: IngestMessage = {
    id,
    source: 'inbound',
    rfcMessageId: `<${id}@test.dev>`,
    threadId: null,
    from: { email: from, name: 'Sender' },
    to: [{ email: 'me@test.dev' }],
    subject: opts.subject ?? 'Weekly deals',
    preview: null,
    sentAt,
    receivedAt: sentAt,
    createdAt: sentAt,
    isRead: false,
    labels: ['INBOX'],
    isSpam: opts.isSpam ?? false,
    isReply: false,
    attachments: [],
  };
  await store.apply({ kind: 'ingest', message }, sentAt);
  await putRawMime(bucket, { workspaceId: WORKSPACE_ID, accountId, messageId: id }, new TextEncoder().encode(`${rawHeaders}\r\n\r\nbody text`));
  return id;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

describe('mail subscriptions · object mode (store supplied)', () => {
  it('scan groups list mail from the object by sender and skips spam and non-list mail', async () => {
    const accountId = generateId('mail');
    bucket = createMemoryR2();
    const store = storeFor(accountId);

    await ingestInbound(store, accountId, 'news@shop.com', 'From: news@shop.com\r\nList-Unsubscribe: <https://shop.com/u>', { daysAgo: 2 });
    await ingestInbound(store, accountId, 'news@shop.com', 'From: news@shop.com\r\nList-Unsubscribe: <https://shop.com/u>', {
      daysAgo: 1,
      subject: 'Newest deals',
    });
    await ingestInbound(store, accountId, 'friend@example.com', 'From: friend@example.com');
    await ingestInbound(store, accountId, 'spam@bad.com', 'List-Unsubscribe: <https://bad.com/u>', { isSpam: true });

    const result = await scanSubscriptions({ MAIL_STORAGE: bucket }, db, { workspaceId: WORKSPACE_ID, accountId }, store);
    expect(result.subscriptions).toBe(1);

    const rows = await listSubscriptions(db, { accountId }, store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      senderEmail: 'news@shop.com',
      messageCount: 2,
      lastSubject: 'Newest deals',
      unsubscribeUrl: 'https://shop.com/u',
      status: 'active',
    });
  });

  it('unsubscribe marks the row through the store and a later scan keeps that state', async () => {
    const accountId = generateId('mail');
    bucket = createMemoryR2();
    const store = storeFor(accountId);

    await ingestInbound(store, accountId, 'letters@paper.com', 'List-Unsubscribe: <https://paper.com/prefs>');
    await scanSubscriptions({ MAIL_STORAGE: bucket }, db, { workspaceId: WORKSPACE_ID, accountId }, store);
    const [sub] = await listSubscriptions(db, { accountId }, store);

    const { outcome, subscription } = await unsubscribe(
      {} as Env,
      db,
      { orgId: ORG_ID, userId: 'user_test', subscription: sub! },
      store,
    );
    expect(outcome).toEqual({ method: 'link', url: 'https://paper.com/prefs' });
    expect(subscription).toMatchObject({ status: 'unsubscribed', unsubscribeMethod: 'link', unsubscribedBy: 'user_test' });

    await scanSubscriptions({ MAIL_STORAGE: bucket }, db, { workspaceId: WORKSPACE_ID, accountId }, store);
    expect(await listSubscriptions(db, { accountId, status: 'unsubscribed' }, store)).toHaveLength(1);
    expect(await listSubscriptions(db, { accountId, status: 'active' }, store)).toHaveLength(0);
  });
});
