/**
 * pglite-backed tests for mail subscriptions: backfill scan from raw headers
 * read out of R2 (docs/plans/weldmail-mailbox-store-design.md decision 4 — the
 * Postgres `raw_message` column workspace mail never populates), listing, and
 * unsubscribe state. Uses a link-only sender so the unsubscribe path needs no
 * network or send binding.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

import { listSubscriptions, scanSubscriptions, unsubscribe } from './subscriptions';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';
import type { Env } from '../../types';
import { putRawMime } from '@weldsuite/mail-domain/store/bodies';
import { MemoryR2Bucket } from '@weldsuite/mail-domain/store/testing/memory-r2';

const { mailAccounts, mailMessages } = schema;

const WORKSPACE_ID = 'ws_test';

let db: Database;
let bucket: MemoryR2Bucket;

async function seedAccount(): Promise<string> {
  const id = generateId('mail');
  await db.insert(mailAccounts).values({ id, name: 'Test', email: 'me@test.dev', isShared: true });
  return id;
}

async function seedInbound(
  accountId: string,
  from: string,
  rawHeaders: string,
  opts: { daysAgo?: number; isSpam?: boolean; subject?: string; noRaw?: boolean } = {},
): Promise<string> {
  const id = generateId('mmsg');
  await db.insert(mailMessages).values({
    id,
    accountId,
    messageId: `<${id}@test.dev>`,
    from: { email: from, name: 'Sender' },
    to: [{ email: 'me@test.dev' }],
    subject: opts.subject ?? 'Weekly deals',
    sentDate: new Date(Date.now() - (opts.daysAgo ?? 1) * 86_400_000),
    labels: ['INBOX'],
    source: 'inbound',
    isSpam: opts.isSpam ?? false,
  });
  if (!opts.noRaw) {
    await putRawMime(
      bucket.asBucket(),
      { workspaceId: WORKSPACE_ID, accountId, messageId: id },
      new TextEncoder().encode(`${rawHeaders}\r\n\r\nbody text`),
    );
  }
  return id;
}

async function scan(accountId: string) {
  return scanSubscriptions({ MAIL_STORAGE: bucket.asBucket() }, db, { workspaceId: WORKSPACE_ID, accountId });
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

beforeEach(() => {
  bucket = new MemoryR2Bucket();
});

describe('mail subscriptions', () => {
  it('scan groups list mail by sender and skips spam, old and non-list mail', async () => {
    const accountId = await seedAccount();
    const shopHeaders = 'From: news@shop.com\r\nList-Unsubscribe: <https://shop.com/u>';
    await seedInbound(accountId, 'News@Shop.com', shopHeaders, { daysAgo: 2 });
    await seedInbound(accountId, 'news@shop.com', shopHeaders, { daysAgo: 1, subject: 'Newest deals' });
    await seedInbound(accountId, 'friend@example.com', 'From: friend@example.com');
    await seedInbound(accountId, 'spam@bad.com', 'List-Unsubscribe: <https://bad.com/u>', { isSpam: true });
    await seedInbound(accountId, 'old@list.org', 'List-Unsubscribe: <https://list.org/u>', { daysAgo: 400 });

    const result = await scan(accountId);
    expect(result.subscriptions).toBe(1);

    const rows = await listSubscriptions(db, { accountId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      senderEmail: 'news@shop.com',
      messageCount: 2,
      lastSubject: 'Newest deals',
      unsubscribeUrl: 'https://shop.com/u',
      oneClick: false,
      status: 'active',
    });
  });

  it('skips a message with no raw MIME in R2 (predates the fix, or the inbound write failed)', async () => {
    const accountId = await seedAccount();
    await seedInbound(accountId, 'news@no-raw.com', 'List-Unsubscribe: <https://no-raw.com/u>', { noRaw: true });

    const result = await scan(accountId);
    expect(result.scanned).toBe(1);
    expect(result.subscriptions).toBe(0);
    expect(await listSubscriptions(db, { accountId })).toHaveLength(0);
  });

  it('finds nothing, never throws, when the worker has no MAIL_STORAGE binding', async () => {
    const accountId = await seedAccount();
    await seedInbound(accountId, 'news@shop.com', 'List-Unsubscribe: <https://shop.com/u>');

    const result = await scanSubscriptions({}, db, { workspaceId: WORKSPACE_ID, accountId });
    expect(result).toEqual({ scanned: 1, subscriptions: 0 });
  });

  it('unsubscribe marks the row and a later scan keeps that state', async () => {
    const accountId = await seedAccount();
    await seedInbound(accountId, 'letters@paper.com', 'List-Unsubscribe: <https://paper.com/prefs>');
    await scan(accountId);
    const [sub] = await listSubscriptions(db, { accountId });

    const { outcome, subscription } = await unsubscribe({} as Env, db, {
      orgId: 'org_test',
      userId: 'user_test',
      subscription: sub!,
    });
    expect(outcome).toEqual({ method: 'link', url: 'https://paper.com/prefs' });
    expect(subscription).toMatchObject({ status: 'unsubscribed', unsubscribeMethod: 'link', unsubscribedBy: 'user_test' });

    await scan(accountId);
    expect(await listSubscriptions(db, { accountId, status: 'unsubscribed' })).toHaveLength(1);
    expect(await listSubscriptions(db, { accountId, status: 'active' })).toHaveLength(0);
  });

  it('keeps subscriptions scoped to their account', async () => {
    const mine = await seedAccount();
    const other = await seedAccount();
    await seedInbound(other, 'x@shared.com', 'List-Unsubscribe: <https://shared.com/u>');
    await scan(mine);
    expect(await listSubscriptions(db, { accountId: mine })).toHaveLength(0);
  });
});
