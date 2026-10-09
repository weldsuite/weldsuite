/**
 * The opt-in send policies the public API sends under, plus workspace-principal
 * sends, reply idempotency and draft-send. Runs the real send+persist path in
 * `dryRun` against pglite (see send-idempotency.test.ts for why that is enough).
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

vi.mock('cloudflare:email', () => ({
  EmailMessage: class {
    constructor(public readonly from: string, public readonly to: string, public readonly raw: string) {}
  },
}));

import {
  countSentToday,
  MailSendError,
  replyAndPersist,
  sendAndPersist,
  sendDraftAndPersist,
  type MailSendEnv,
} from './send';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';
import type { MailPrincipal } from './access';

const { mailAccounts, mailDomains, mailDrafts, mailMessages } = schema;

const env = {} as unknown as MailSendEnv;
const ORG = 'org_test';
const WORKSPACE: MailPrincipal = { kind: 'workspace', keyId: 'key_ws' };
const base = { to: ['rcpt@example.com'], subject: 'Hi', body: 'Body' };
const API = { dryRun: true, enforceDailyLimit: true, requireVerifiedDomain: true } as const;

let db: Database;

async function seedAccount(email: string, fields: Partial<typeof mailAccounts.$inferInsert> = {}): Promise<string> {
  const id = generateId('mail');
  await db.insert(mailAccounts).values({ id, name: email, email, isShared: true, ...fields });
  return id;
}

async function expectSendError(promise: Promise<unknown>, code: MailSendError['code']): Promise<MailSendError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(MailSendError);
  expect((err as MailSendError).code).toBe(code);
  return err as MailSendError;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(mailDomains).values({ id: generateId('mdom'), domainName: 'verified.dev', dnsStatus: 'verified' });
  await db.insert(mailDomains).values({ id: generateId('mdom'), domainName: 'pending.dev', dnsStatus: 'pending' });
}, 60_000);

describe('requireVerifiedDomain', () => {
  it('refuses an address on an unverified or foreign domain', async () => {
    const gmail = await seedAccount('someone@gmail.com');
    const pending = await seedAccount('ops@pending.dev');
    await expectSendError(sendAndPersist(env, db, ORG, WORKSPACE, gmail, base, API), 'SENDER_DOMAIN_NOT_VERIFIED');
    await expectSendError(sendAndPersist(env, db, ORG, WORKSPACE, pending, base, API), 'SENDER_DOMAIN_NOT_VERIFIED');
  });

  it('is off unless asked for (platform behaviour unchanged)', async () => {
    const gmail = await seedAccount('another@gmail.com');
    await expect(sendAndPersist(env, db, ORG, WORKSPACE, gmail, base, { dryRun: true })).resolves.toBeTruthy();
  });
});

describe('enforceDailyLimit', () => {
  it('stops at dailySendLimit and reports when it resets', async () => {
    const accountId = await seedAccount('limited@verified.dev', { dailySendLimit: 2 });
    await sendAndPersist(env, db, ORG, WORKSPACE, accountId, base, API);
    await sendAndPersist(env, db, ORG, WORKSPACE, accountId, base, API);
    const err = await expectSendError(
      sendAndPersist(env, db, ORG, WORKSPACE, accountId, base, API),
      'DAILY_LIMIT_REACHED',
    );
    expect(err.details).toMatchObject({ limit: 2, sent: 2 });
    expect(await countSentToday(db, accountId)).toBe(2);
  });

  it('a replay of a send that already went out is not refused by the limit', async () => {
    const accountId = await seedAccount('replay@verified.dev', { dailySendLimit: 1 });
    const first = await sendAndPersist(env, db, ORG, WORKSPACE, accountId, { ...base, idempotencyKey: 'once' }, API);
    const again = await sendAndPersist(env, db, ORG, WORKSPACE, accountId, { ...base, idempotencyKey: 'once' }, API);
    expect(again.messageId).toBe(first.messageId);
  });

  it('deleting a sent message does not give the send back', async () => {
    const accountId = await seedAccount('deleted@verified.dev', { dailySendLimit: 1 });
    const sent = await sendAndPersist(env, db, ORG, WORKSPACE, accountId, base, API);
    await db.update(mailMessages).set({ deletedAt: new Date() }).where(eq(mailMessages.id, sent.messageId));
    await expectSendError(sendAndPersist(env, db, ORG, WORKSPACE, accountId, base, API), 'DAILY_LIMIT_REACHED');
  });
});

describe('workspace principal sends', () => {
  it('cannot send from a private mailbox (it looks missing)', async () => {
    const privateId = await seedAccount('private@verified.dev', { isShared: false, assignedUserIds: ['user_x'] });
    await expectSendError(sendAndPersist(env, db, ORG, WORKSPACE, privateId, base, API), 'ACCOUNT_NOT_FOUND');
  });
});

describe('reply idempotency', () => {
  it('a replayed reply with the same key sends once', async () => {
    const accountId = await seedAccount('support@verified.dev');
    const originalId = generateId('msg');
    await db.insert(mailMessages).values({
      id: originalId,
      accountId,
      messageId: '<orig@example.com>',
      subject: 'Question',
      from: { email: 'customer@example.com' },
      to: [{ email: 'support@verified.dev' }],
      labels: ['INBOX'],
      sentDate: new Date(),
    });
    const first = await replyAndPersist(env, db, ORG, WORKSPACE, originalId, { body: 'Answer', idempotencyKey: 'r1' }, API);
    const second = await replyAndPersist(env, db, ORG, WORKSPACE, originalId, { body: 'Answer', idempotencyKey: 'r1' }, API);
    expect(second.messageId).toBe(first.messageId);
    const replies = await db
      .select({ id: mailMessages.id })
      .from(mailMessages)
      .where(and(eq(mailMessages.accountId, accountId), eq(mailMessages.source, 'sent')));
    expect(replies).toHaveLength(1);
  });
});

describe('sendDraftAndPersist', () => {
  it('sends the draft and deletes it', async () => {
    const accountId = await seedAccount('drafts@verified.dev');
    const draftId = generateId('draft');
    await db.insert(mailDrafts).values({ id: draftId, accountId, to: ['rcpt@example.com'], subject: 'From a draft', body: 'Hi' });

    const result = await sendDraftAndPersist(env, db, ORG, WORKSPACE, draftId, {}, API);
    expect(result.subject).toBe('From a draft');
    const [draft] = await db.select({ deletedAt: mailDrafts.deletedAt }).from(mailDrafts).where(eq(mailDrafts.id, draftId));
    expect(draft?.deletedAt).not.toBeNull();
  });

  it('keeps the draft when the send fails', async () => {
    const accountId = await seedAccount('blocked@gmail.com');
    const draftId = generateId('draft');
    await db.insert(mailDrafts).values({ id: draftId, accountId, to: ['rcpt@example.com'], subject: 'Stays' });

    await expectSendError(sendDraftAndPersist(env, db, ORG, WORKSPACE, draftId, {}, API), 'SENDER_DOMAIN_NOT_VERIFIED');
    const [draft] = await db.select({ deletedAt: mailDrafts.deletedAt }).from(mailDrafts).where(eq(mailDrafts.id, draftId));
    expect(draft?.deletedAt).toBeNull();
  });

  it('refuses a draft without recipients, and a missing draft', async () => {
    const accountId = await seedAccount('empty@verified.dev');
    const draftId = generateId('draft');
    await db.insert(mailDrafts).values({ id: draftId, accountId, subject: 'No one' });
    await expectSendError(sendDraftAndPersist(env, db, ORG, WORKSPACE, draftId, {}, API), 'INVALID_RECIPIENTS');
    await expectSendError(sendDraftAndPersist(env, db, ORG, WORKSPACE, 'draft_missing', {}, API), 'DRAFT_NOT_FOUND');
  });
});
