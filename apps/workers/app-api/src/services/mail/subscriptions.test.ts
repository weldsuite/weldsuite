/**
 * pglite-backed tests for mail subscriptions: backfill scan from stored raw
 * headers, listing, and unsubscribe state. Uses a link-only sender so the
 * unsubscribe path needs no network or send binding.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { listSubscriptions, scanSubscriptions, unsubscribe } from './subscriptions';
import { createPgliteDb } from '../../test/pglite';
import { schema } from '../../db';
import { generateId } from '../../lib/id';
import type { Database } from '../../db';
import type { Env } from '../../types';

const { mailAccounts, mailMessages } = schema;

let db: Database;

async function seedAccount(): Promise<string> {
  const id = generateId('mail');
  await db.insert(mailAccounts).values({ id, name: 'Test', email: 'me@test.dev', isShared: true });
  return id;
}

async function seedInbound(
  accountId: string,
  from: string,
  rawHeaders: string,
  opts: { daysAgo?: number; isSpam?: boolean; subject?: string } = {},
) {
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
    rawMessage: `${rawHeaders}\r\n\r\nbody text`,
  });
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('mail subscriptions', () => {
  it('scan groups list mail by sender and skips spam, old and non-list mail', async () => {
    const accountId = await seedAccount();
    const shopHeaders = 'From: news@shop.com\r\nList-Unsubscribe: <https://shop.com/u>';
    await seedInbound(accountId, 'News@Shop.com', shopHeaders, { daysAgo: 2 });
    await seedInbound(accountId, 'news@shop.com', shopHeaders, { daysAgo: 1, subject: 'Newest deals' });
    await seedInbound(accountId, 'friend@example.com', 'From: friend@example.com');
    await seedInbound(accountId, 'spam@bad.com', 'List-Unsubscribe: <https://bad.com/u>', { isSpam: true });
    await seedInbound(accountId, 'old@list.org', 'List-Unsubscribe: <https://list.org/u>', { daysAgo: 400 });

    const result = await scanSubscriptions(db, accountId);
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

  it('unsubscribe marks the row and a later scan keeps that state', async () => {
    const accountId = await seedAccount();
    await seedInbound(accountId, 'letters@paper.com', 'List-Unsubscribe: <https://paper.com/prefs>');
    await scanSubscriptions(db, accountId);
    const [sub] = await listSubscriptions(db, { accountId });

    const { outcome, subscription } = await unsubscribe({} as Env, db, {
      orgId: 'org_test',
      userId: 'user_test',
      subscription: sub!,
    });
    expect(outcome).toEqual({ method: 'link', url: 'https://paper.com/prefs' });
    expect(subscription).toMatchObject({ status: 'unsubscribed', unsubscribeMethod: 'link', unsubscribedBy: 'user_test' });

    await scanSubscriptions(db, accountId);
    expect(await listSubscriptions(db, { accountId, status: 'unsubscribed' })).toHaveLength(1);
    expect(await listSubscriptions(db, { accountId, status: 'active' })).toHaveLength(0);
  });

  it('keeps subscriptions scoped to their account', async () => {
    const mine = await seedAccount();
    const other = await seedAccount();
    await seedInbound(other, 'x@shared.com', 'List-Unsubscribe: <https://shared.com/u>');
    await scanSubscriptions(db, mine);
    expect(await listSubscriptions(db, { accountId: mine })).toHaveLength(0);
  });
});
