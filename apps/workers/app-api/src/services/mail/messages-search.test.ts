/**
 * pglite-backed tests for listMessages search: case-insensitive, matches the
 * sender, and treats LIKE wildcards literally.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { listMessages } from './messages';
import { createPgliteDb } from '../../test/pglite';
import { schema } from '../../db';
import { generateId } from '../../lib/id';
import type { Database } from '../../db';

const { mailAccounts, mailMessages } = schema;

let db: Database;
let accountId: string;

async function seedMessage(subject: string, from: { email: string; name?: string }, preview = '') {
  const id = generateId('mmsg');
  await db.insert(mailMessages).values({
    id,
    accountId,
    threadId: `thread_${id}`,
    messageId: `<${id}@test.dev>`,
    from,
    to: [{ email: 'me@test.dev' }],
    subject,
    preview,
    sentDate: new Date(),
    labels: ['INBOX'],
  });
  return id;
}

describe('listMessages search', () => {
  let invoice: string;
  let fromAda: string;
  let discount: string;

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
    accountId = generateId('mail');
    await db.insert(mailAccounts).values({ id: accountId, name: 'Test', email: 'me@test.dev', isShared: true });
    invoice = await seedMessage('Your Invoice for September', { email: 'billing@shop.dev' });
    fromAda = await seedMessage('Lunch?', { email: 'ada@lovelace.dev', name: 'Ada Lovelace' });
    discount = await seedMessage('Save 50% today', { email: 'promo@shop.dev' });
    await seedMessage('Save 500 today', { email: 'promo@shop.dev' });
  }, 60_000);

  const ids = async (search: string) =>
    (await listMessages(db, { accountId, search })).data.map((m) => m.id);

  it('ignores case in subject and preview', async () => {
    expect(await ids('invoice')).toEqual([invoice]);
  });

  it('matches the sender name and address', async () => {
    expect(await ids('lovelace')).toEqual([fromAda]);
    expect(await ids('ADA LOVE')).toEqual([fromAda]);
  });

  it('treats % literally', async () => {
    expect(await ids('50%')).toEqual([discount]);
  });
});
