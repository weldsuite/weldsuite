/**
 * Object-mode tests for mail AI's store wiring (design task D1): message
 * content for a prompt is refreshed from a real `ObjectMailboxStore` (the C2
 * fakes, running the real `MailboxObject` class) when the caller passes a
 * non-`postgres` mode, and a classification write-back goes through the
 * store's `categories` op. The direct-Postgres row stays the source of
 * existence/access gating in every mode (`access.test.ts`'s own 403/404
 * behaviour is unaffected, verified separately there).
 */

const ai = vi.hoisted(() => ({ generateText: vi.fn(), generateObject: vi.fn() }));

vi.mock('@weldsuite/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/ai')>()),
  assertGatewayConfigured: vi.fn(),
  createWeldAI: () => ({ model: (id: string) => id }),
  generateText: ai.generateText,
  generateObject: ai.generateObject,
}));

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { classifyMessage, inboxSummary, smartReplies } from './ai';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';
import type { Env } from '../../types';
import { ObjectMailboxStore } from '@weldsuite/mail-domain/store/object';
import { createFakeMailboxNamespace } from '@weldsuite/mail-domain/store/object/testing/fake-env';
import type { IngestMessage, MailboxRef, MailboxStore, WorkspaceMailStore } from '@weldsuite/mail-domain/store/types';
import type { MailAccess } from '@weldsuite/mail-domain/store';

/** ai.ts only ever calls `.mailbox(accountId)` on this — a thin wrapper is enough. */
function workspaceStoreOf(mailboxStore: MailboxStore, accountId: string): WorkspaceMailStore {
  return {
    mailbox: (id: string) => {
      if (id !== accountId) throw new Error(`unexpected mailbox lookup for ${id}`);
      return mailboxStore;
    },
  } as unknown as WorkspaceMailStore;
}

/**
 * `object-only`'s fallback path also calls `locateMessages` (there is no
 * Postgres row to find the account from) — answers it from the real mailbox
 * store's own `getMessages`, same presence semantics `ObjectWorkspaceMailStore`
 * itself has, without pulling in the real fan-out machinery for a one-mailbox
 * test.
 */
function workspaceStoreWithLocate(mailboxStore: MailboxStore, accountId: string): WorkspaceMailStore {
  return {
    ...workspaceStoreOf(mailboxStore, accountId),
    locateMessages: async (ids: string[], accountIds: string[]) => {
      if (!accountIds.includes(accountId)) return new Map<string, string>();
      const rows = await mailboxStore.getMessages(ids);
      return new Map(rows.map((r) => [r.id, accountId]));
    },
  } as unknown as WorkspaceMailStore;
}

/** `loadMessage`'s object-mode fallback only ever calls these two methods. */
function fakeAccess(accountIds: string[]): MailAccess {
  return {
    accessibleAccountIds: async () => accountIds,
    canOpen: async (id: string) => accountIds.includes(id),
  } as unknown as MailAccess;
}

const { mailAccounts, mailMessages } = schema;

const WORKSPACE_ID = 'ws_ai_object';
const ORG_ID = 'org_ai_object';
const USER = 'user_1';

let db: Database;

/** Everything the prompt mocks were called with, as one string. */
function promptsSent(): string {
  return JSON.stringify([...ai.generateText.mock.calls, ...ai.generateObject.mock.calls]);
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(() => {
  ai.generateText.mockReset().mockResolvedValue({ text: 'generated', usage: {} });
  ai.generateObject.mockReset().mockResolvedValue({
    object: { subject: 's', body: 'b', replies: ['ok'], category: 'sales', priority: 'normal' },
    usage: {},
  });
});

describe('mail AI · object mode (store supplied)', () => {
  it('reads message content from the store, not the stale Postgres row', async () => {
    const accountId = generateId('mail');
    await db.insert(mailAccounts).values({ id: accountId, name: 'Shared', email: `${accountId}@test.dev`, isShared: true });

    const messageId = generateId('mmsg');
    // A stale Postgres row — in `shadow`/`object` modes this is what's left
    // over, or never populated; the store holds the live content.
    await db.insert(mailMessages).values({
      id: messageId,
      accountId,
      threadId: `thread_${messageId}`,
      messageId: `<${messageId}@test.dev>`,
      from: { email: 'stale@example.com' },
      to: [{ email: 'me@test.dev' }],
      subject: 'STALE SUBJECT',
      preview: 'stale preview',
      textBody: 'stale body',
      sentDate: new Date(),
      labels: ['INBOX'],
    });

    const mailbox = createFakeMailboxNamespace();
    const ref: MailboxRef = { workspaceId: WORKSPACE_ID, accountId, clerkOrgId: ORG_ID };
    const store = new ObjectMailboxStore({ MAILBOX_STORE: mailbox.namespace, MAIL_STORAGE: createMemoryR2() }, ref);
    const message: IngestMessage = {
      id: messageId,
      source: 'inbound',
      rfcMessageId: `<${messageId}@test.dev>`,
      threadId: null,
      from: { email: 'fresh@example.com' },
      to: [{ email: 'me@test.dev' }],
      subject: 'FRESH SUBJECT FROM THE OBJECT',
      preview: 'fresh preview',
      sentAt: Date.now(),
      receivedAt: Date.now(),
      createdAt: Date.now(),
      isRead: false,
      labels: ['INBOX'],
      isSpam: false,
      isReply: false,
      content: { html: null, text: 'fresh body from the object' },
      attachments: [],
    };
    // Ingest under the message's own id so the store's `getMessage(messageId)`
    // (keyed by id, not by the Postgres row's own identity) answers for it.
    await store.apply({ kind: 'ingest', message }, Date.now());

    await smartReplies({} as Env, db, USER, { messageId }, null, workspaceStoreOf(store, accountId), 'object');

    expect(promptsSent()).toContain('FRESH SUBJECT FROM THE OBJECT');
    expect(promptsSent()).toContain('fresh body from the object');
    expect(promptsSent()).not.toContain('STALE SUBJECT');
  });

  it('writes a classification through the store categories op', async () => {
    const accountId = generateId('mail');
    await db.insert(mailAccounts).values({ id: accountId, name: 'Shared', email: `${accountId}@test.dev`, isShared: true });

    const messageId = generateId('mmsg');
    await db.insert(mailMessages).values({
      id: messageId,
      accountId,
      threadId: `thread_${messageId}`,
      messageId: `<${messageId}@test.dev>`,
      from: { email: 'sender@example.com' },
      to: [{ email: 'me@test.dev' }],
      subject: 'Invoice overdue',
      sentDate: new Date(),
      labels: ['INBOX'],
    });

    const mailbox = createFakeMailboxNamespace();
    const ref: MailboxRef = { workspaceId: WORKSPACE_ID, accountId, clerkOrgId: ORG_ID };
    const store = new ObjectMailboxStore({ MAILBOX_STORE: mailbox.namespace, MAIL_STORAGE: createMemoryR2() }, ref);
    const message: IngestMessage = {
      id: messageId,
      source: 'inbound',
      rfcMessageId: `<${messageId}@test.dev>`,
      threadId: null,
      from: { email: 'sender@example.com' },
      to: [{ email: 'me@test.dev' }],
      subject: 'Invoice overdue',
      preview: null,
      sentAt: Date.now(),
      receivedAt: Date.now(),
      createdAt: Date.now(),
      isRead: false,
      labels: ['INBOX'],
      isSpam: false,
      isReply: false,
      attachments: [],
    };
    await store.apply({ kind: 'ingest', message }, Date.now());

    const result = await classifyMessage({} as Env, db, USER, { messageId }, null, workspaceStoreOf(store, accountId), 'object');
    expect(result.category).toBe('sales');

    const record = await store.getMessage(messageId);
    expect(record?.categories).toEqual(['ai:sales']);

    // The Postgres row (stale by design in object mode) never got the write.
    const [pgRow] = await db
      .select({ categories: mailMessages.categories })
      .from(mailMessages)
      .where(eq(mailMessages.id, messageId));
    expect(pgRow?.categories ?? null).toBeNull();
  });
});

describe('mail AI · object-only mode (zero Postgres mail rows)', () => {
  it('locates a message that has no Postgres row at all, via store.locateMessages + access', async () => {
    const accountId = generateId('mail');
    await db.insert(mailAccounts).values({ id: accountId, name: 'Shared', email: `${accountId}@test.dev`, isShared: true });

    const messageId = generateId('mmsg');
    const mailbox = createFakeMailboxNamespace();
    const ref: MailboxRef = { workspaceId: WORKSPACE_ID, accountId, clerkOrgId: ORG_ID };
    const store = new ObjectMailboxStore({ MAILBOX_STORE: mailbox.namespace, MAIL_STORAGE: createMemoryR2() }, ref);
    const message: IngestMessage = {
      id: messageId,
      source: 'inbound',
      rfcMessageId: `<${messageId}@test.dev>`,
      threadId: null,
      from: { email: 'fresh@example.com' },
      to: [{ email: 'me@test.dev' }],
      subject: 'OBJECT ONLY SUBJECT',
      preview: 'preview',
      sentAt: Date.now(),
      receivedAt: Date.now(),
      createdAt: Date.now(),
      isRead: false,
      labels: ['INBOX'],
      isSpam: false,
      isReply: false,
      content: { html: null, text: 'object only body' },
      attachments: [],
    };
    // No Postgres `mail_messages` row for this id at all — `object-only`
    // never writes one, unlike the `object`-mode tests above (which insert a
    // stale one on purpose).
    await store.apply({ kind: 'ingest', message }, Date.now());

    const workspaceStore = workspaceStoreWithLocate(store, accountId);
    const access = fakeAccess([accountId]);

    await smartReplies({} as Env, db, USER, { messageId }, null, workspaceStore, 'object-only', access);

    expect(promptsSent()).toContain('OBJECT ONLY SUBJECT');
    expect(promptsSent()).toContain('object only body');

    const pgRows = await db.select({ id: mailMessages.id }).from(mailMessages).where(eq(mailMessages.id, messageId));
    expect(pgRows).toHaveLength(0);
  });

  it("answers MESSAGE_NOT_FOUND for a mailbox outside the caller's accessible list (no existence leak)", async () => {
    const accountId = generateId('mail');
    await db.insert(mailAccounts).values({
      id: accountId,
      name: 'Private',
      email: `${accountId}@test.dev`,
      isShared: false,
      assignedUserIds: [],
    });

    const messageId = generateId('mmsg');
    const mailbox = createFakeMailboxNamespace();
    const ref: MailboxRef = { workspaceId: WORKSPACE_ID, accountId, clerkOrgId: ORG_ID };
    const store = new ObjectMailboxStore({ MAILBOX_STORE: mailbox.namespace, MAIL_STORAGE: createMemoryR2() }, ref);
    const message: IngestMessage = {
      id: messageId,
      source: 'inbound',
      rfcMessageId: `<${messageId}@test.dev>`,
      threadId: null,
      from: { email: 'fresh@example.com' },
      to: [{ email: 'me@test.dev' }],
      subject: 'Hidden',
      preview: null,
      sentAt: Date.now(),
      receivedAt: Date.now(),
      createdAt: Date.now(),
      isRead: false,
      labels: ['INBOX'],
      isSpam: false,
      isReply: false,
      attachments: [],
    };
    await store.apply({ kind: 'ingest', message }, Date.now());

    const workspaceStore = workspaceStoreWithLocate(store, accountId);
    const access = fakeAccess([]); // this caller may not open any mailbox

    await expect(
      smartReplies({} as Env, db, USER, { messageId }, null, workspaceStore, 'object-only', access),
    ).rejects.toMatchObject({ code: 'MESSAGE_NOT_FOUND' });
  });

  it('classifies a message with zero Postgres rows, through the store categories op', async () => {
    const accountId = generateId('mail');
    await db.insert(mailAccounts).values({ id: accountId, name: 'Shared', email: `${accountId}@test.dev`, isShared: true });

    const messageId = generateId('mmsg');
    const mailbox = createFakeMailboxNamespace();
    const ref: MailboxRef = { workspaceId: WORKSPACE_ID, accountId, clerkOrgId: ORG_ID };
    const store = new ObjectMailboxStore({ MAILBOX_STORE: mailbox.namespace, MAIL_STORAGE: createMemoryR2() }, ref);
    const message: IngestMessage = {
      id: messageId,
      source: 'inbound',
      rfcMessageId: `<${messageId}@test.dev>`,
      threadId: null,
      from: { email: 'sender@example.com' },
      to: [{ email: 'me@test.dev' }],
      subject: 'Invoice overdue',
      preview: null,
      sentAt: Date.now(),
      receivedAt: Date.now(),
      createdAt: Date.now(),
      isRead: false,
      labels: ['INBOX'],
      isSpam: false,
      isReply: false,
      attachments: [],
    };
    await store.apply({ kind: 'ingest', message }, Date.now());

    const workspaceStore = workspaceStoreWithLocate(store, accountId);
    const access = fakeAccess([accountId]);

    const result = await classifyMessage(
      {} as Env,
      db,
      USER,
      { messageId },
      null,
      workspaceStore,
      'object-only',
      access,
    );
    expect(result.category).toBe('sales');

    const record = await store.getMessage(messageId);
    expect(record?.categories).toEqual(['ai:sales']);
  });
});

describe('mail AI · inbox-summary recent-messages trash filter (object modes)', () => {
  it("excludes trash from the object store's recentMessages, matching postgres mode", async () => {
    // `store.recentMessages` has no `excludeTrash` option of its own
    // (design §5) — `loadRecentMessages` filters `isTrash` out itself so the
    // digest matches what the direct Postgres query has always excluded.
    const accountId = generateId('mail');
    await db.insert(mailAccounts).values({ id: accountId, name: 'Shared', email: `${accountId}@test.dev`, isShared: true });

    const liveId = generateId('mmsg');
    const trashId = generateId('mmsg');
    const store = {
      recentMessages: async () => [
        { id: liveId, subject: 'Live message', from: { email: 'a@test.dev' }, preview: 'p', isRead: false, isTrash: false },
        { id: trashId, subject: 'Trashed message', from: { email: 'b@test.dev' }, preview: 'p', isRead: false, isTrash: true },
      ],
    } as unknown as WorkspaceMailStore;

    const result = await inboxSummary({} as Env, db, USER, { accountId }, null, store, 'object-only');

    expect(promptsSent()).toContain('Live message');
    expect(promptsSent()).not.toContain('Trashed message');
    expect(result.summary).toBe('generated');
  });
});
