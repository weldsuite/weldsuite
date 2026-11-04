/**
 * The Message-IDs a SENT copy is recorded under.
 *
 * Cloudflare replaces the Message-ID of every message it sends, a different
 * one per envelope, and resolves `send()` with it (live send, 2026-11-04). The
 * SENT copy must hold the ids recipients actually got, or nothing matches it:
 * a reply's In-Reply-To finds nothing, and mail the account sent to itself is
 * stored a second time as unread inbox mail.
 *
 * Runs the real (non-dry-run) send path against pglite with a `SEND_EMAIL`
 * stub that answers like Cloudflare, in the three ways a SENT copy is
 * persisted: direct Postgres, the Postgres store, the mailbox object.
 */

vi.mock('cloudflare:email', () => ({
  EmailMessage: class {
    constructor(public readonly from: string, public readonly to: string, public readonly raw: string) {}
  },
}));

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { createSendEmailStub } from '@weldsuite/worker-kit/testing/send-email';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { sendAndPersist, sentCopyMessageIds, type MailSendEnv } from './send';
import { resolveInbound } from './store/postgres/inbound';
import { PostgresMailboxStore } from './store/postgres/mailbox-store';
import { ObjectMailboxStore } from './store/object';
import { createFakeMailboxNamespace } from './store/object/testing/fake-env';
import type { IngestMessage, MailboxStore } from './store/types';

const { mailAccounts, mailMessages } = schema;

const ORG = 'org_test';
const USER = 'user_test';
const SELF = 'me@acme.test';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

/** MX answers for the recipient domains, so nothing goes to the network. */
function mxCache() {
  const values = new Map<string, string>([
    ['mx:acme.test', '1'],
    ['mx:x.test', '1'],
  ]);
  return {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => void values.set(key, value),
    delete: async (key: string) => void values.delete(key),
  };
}

/**
 * The id Cloudflare would deliver to `recipient`: one per envelope, none of
 * them the message's own. `tag` keeps tests apart.
 */
function delivered(tag: string, recipient: string): string {
  return `<${tag}.${recipient.replace('@', '.')}@acme.test>`;
}

function envFor(tag: string) {
  const stub = createSendEmailStub({}, { messageId: (e) => delivered(tag, e.to.toLowerCase()) });
  const env = { SEND_EMAIL: stub, WORKSPACE_CACHE: mxCache() } as unknown as MailSendEnv;
  return { env, stub };
}

async function seedAccount(): Promise<string> {
  const id = generateId('mail');
  await db.insert(mailAccounts).values({ id, name: 'Me', email: SELF, isShared: true });
  return id;
}

/** The copy of a sent message Cloudflare delivers back to the sending mailbox. */
function selfCopy(rfcMessageId: string, subject: string): IngestMessage {
  return {
    id: generateId('msg'),
    source: 'inbound',
    rfcMessageId,
    threadId: rfcMessageId,
    from: { email: SELF },
    to: [{ email: SELF }, { email: 'sara@x.test' }],
    subject,
    preview: 'Hi',
    sentAt: Date.now(),
    receivedAt: Date.now(),
    createdAt: Date.now(),
    isRead: false,
    labels: ['INBOX'],
    isSpam: false,
    isReply: false,
    attachments: [],
  };
}

describe('sentCopyMessageIds', () => {
  const result = (delivered: Record<string, string>) => ({ messageId: '<built@acme.test>', deliveredMessageIds: delivered });

  it('records the first outside recipient as the RFC id and the self-copy as the external id', () => {
    const ids = sentCopyMessageIds(
      'Me@Acme.test',
      { to: ['me@acme.test', 'sara@x.test'], cc: ['bob@x.test'] },
      result({ 'me@acme.test': '<self@acme.test>', 'sara@x.test': '<sara@acme.test>', 'bob@x.test': '<bob@acme.test>' }),
    );
    expect(ids).toEqual({ rfcMessageId: '<sara@acme.test>', externalMessageId: '<self@acme.test>', selfMessageId: '<self@acme.test>' });
  });

  it('uses the self-copy for both when the account wrote only to itself', () => {
    const ids = sentCopyMessageIds(SELF, { to: [SELF] }, result({ [SELF]: '<self@acme.test>' }));
    expect(ids).toEqual({ rfcMessageId: '<self@acme.test>', externalMessageId: '<self@acme.test>', selfMessageId: '<self@acme.test>' });
  });

  it('skips a recipient that got no id (pending, suppressed) and follows to → cc → bcc', () => {
    const ids = sentCopyMessageIds(SELF, { to: ['pending@x.test'], cc: [], bcc: ['b@x.test'] }, result({ 'b@x.test': '<b@acme.test>' }));
    expect(ids).toMatchObject({ rfcMessageId: '<b@acme.test>', externalMessageId: '<b@acme.test>', selfMessageId: null });
  });

  it("falls back to the provider's id without per-envelope ids", () => {
    const ids = sentCopyMessageIds(SELF, { to: ['sara@x.test'] }, { messageId: 'built@acme.test' });
    expect(ids).toEqual({ rfcMessageId: '<built@acme.test>', externalMessageId: 'built@acme.test', selfMessageId: null });
  });
});

describe('sendAndPersist · the ids Cloudflare delivered (direct Postgres)', () => {
  it('stores the ids recipients received, not the one the message was built with', async () => {
    const accountId = await seedAccount();
    const { env, stub } = envFor('pg1');

    const sent = await sendAndPersist(env, db, ORG, USER, accountId, { to: [SELF, 'sara@x.test'], subject: 'Plan', body: 'Hi' });

    expect(sent.smtpMessageId).toBe(delivered('pg1', 'sara@x.test'));
    expect(sent.externalMessageId).toBe(delivered('pg1', SELF));
    const [row] = await db.select().from(mailMessages).where(eq(mailMessages.id, sent.messageId));
    expect(row).toMatchObject({ messageId: delivered('pg1', 'sara@x.test'), externalMessageId: delivered('pg1', SELF) });
    // The built id is in the transmitted message, and nowhere else.
    expect(stub.sent[0]!.raw).not.toContain(delivered('pg1', 'sara@x.test'));
  });

  it("recognises the account's own copy as a duplicate, and threads an outside reply by In-Reply-To", async () => {
    const accountId = await seedAccount();
    const { env } = envFor('pg2');
    const sent = await sendAndPersist(env, db, ORG, USER, accountId, { to: [SELF, 'sara@x.test'], subject: 'Plan', body: 'Hi' });
    const [row] = await db.select().from(mailMessages).where(eq(mailMessages.id, sent.messageId));

    const own = await resolveInbound(db, accountId, {
      rfcMessageId: delivered('pg2', SELF),
      subject: 'Plan',
      fromEmail: SELF,
      isReply: false,
    });
    expect(own.duplicate).toBe(true);

    const reply = await resolveInbound(db, accountId, {
      rfcMessageId: '<reply-1@x.test>',
      inReplyTo: delivered('pg2', 'sara@x.test'),
      references: [delivered('pg2', 'sara@x.test')],
      subject: 'Re: Unrelated subject',
      fromEmail: 'sara@x.test',
      isReply: true,
    });
    expect(reply).toMatchObject({ duplicate: false, threadId: row!.threadId });
  });

  it('removes a self-copy that was stored before the SENT row existed', async () => {
    const accountId = await seedAccount();
    const { env } = envFor('pg3');
    const early = selfCopy(delivered('pg3', SELF), 'Plan');
    await db.insert(mailMessages).values({
      id: early.id,
      accountId,
      messageId: early.rfcMessageId,
      threadId: early.threadId,
      from: early.from,
      to: early.to,
      subject: early.subject,
      sentDate: new Date(),
      source: 'inbound',
      labels: ['INBOX'],
    });

    const sent = await sendAndPersist(env, db, ORG, USER, accountId, { to: [SELF, 'sara@x.test'], subject: 'Plan', body: 'Hi' });

    const live = await db
      .select({ id: mailMessages.id, deletedAt: mailMessages.deletedAt })
      .from(mailMessages)
      .where(and(eq(mailMessages.accountId, accountId)));
    expect(live.filter((m) => m.deletedAt === null).map((m) => m.id)).toEqual([sent.messageId]);
  });
});

describe.each([
  ['Postgres store', (accountId: string): MailboxStore => new PostgresMailboxStore(db, { workspaceId: 'ws_ids', accountId, clerkOrgId: ORG })],
  [
    'mailbox object',
    (accountId: string): MailboxStore =>
      new ObjectMailboxStore(
        { MAILBOX_STORE: createFakeMailboxNamespace().namespace, MAIL_STORAGE: createMemoryR2() },
        { workspaceId: 'ws_ids', accountId, clerkOrgId: ORG },
      ),
  ],
])('sendAndPersist · the ids Cloudflare delivered (%s)', (_name, storeFor) => {
  it('a send to your own mailbox leaves one message: the self-copy is a duplicate', async () => {
    const accountId = await seedAccount();
    const store = storeFor(accountId);
    const { env } = envFor('st1');

    const sent = await sendAndPersist(env, db, ORG, USER, accountId, { to: [SELF, 'sara@x.test'], subject: 'Plan', body: 'Hi' }, { store });
    const record = await store.getMessage(sent.messageId);
    expect(record).toMatchObject({ messageId: delivered('st1', 'sara@x.test'), externalMessageId: delivered('st1', SELF) });

    const own = await store.resolveInbound({ rfcMessageId: delivered('st1', SELF), subject: 'Plan', fromEmail: SELF, isReply: false });
    expect(own.duplicate).toBe(true);

    const reply = await store.resolveInbound({
      rfcMessageId: '<reply-2@x.test>',
      inReplyTo: delivered('st1', 'sara@x.test'),
      subject: 'Re: Plan',
      fromEmail: 'sara@x.test',
      isReply: true,
    });
    expect(reply).toMatchObject({ duplicate: false, threadId: record!.threadId });
  });

  it('removes a self-copy that the inbound worker stored before the SENT row', async () => {
    const accountId = await seedAccount();
    const store = storeFor(accountId);
    const { env } = envFor('st2');
    const early = selfCopy(delivered('st2', SELF), 'Plan');
    await store.apply({ kind: 'ingest', message: early });

    const sent = await sendAndPersist(env, db, ORG, USER, accountId, { to: [SELF, 'sara@x.test'], subject: 'Plan', body: 'Hi' }, { store });

    expect(await store.getMessage(early.id)).toBeNull();
    expect(await store.getMessage(sent.messageId)).not.toBeNull();
  });
});

describe('the mailbox object turns a self-copy away at ingest, after the SENT row', () => {
  it('the inbound copy that loses the race to the SENT row is not stored', async () => {
    const accountId = await seedAccount();
    const store = new ObjectMailboxStore(
      { MAILBOX_STORE: createFakeMailboxNamespace().namespace, MAIL_STORAGE: createMemoryR2() },
      { workspaceId: 'ws_ids', accountId, clerkOrgId: ORG },
    );
    const { env } = envFor('st3');
    // The inbound worker resolved before the send persisted (no duplicate yet)…
    const before = await store.resolveInbound({ rfcMessageId: delivered('st3', SELF), subject: 'Plan', fromEmail: SELF, isReply: false });
    expect(before.duplicate).toBe(false);
    // …the send persisted its SENT row…
    await sendAndPersist(env, db, ORG, USER, accountId, { to: [SELF], subject: 'Plan', body: 'Hi' }, { store });
    // …and the ingest then lands on it.
    const result = await store.apply({ kind: 'ingest', message: selfCopy(delivered('st3', SELF), 'Plan') });
    expect(result.ingest?.duplicateOf).toBeTruthy();
  });
});
