/**
 * `object-only`-mode test for `/api/mail-ai/*` (design task D2's object-mode
 * coverage, mirrors `mail-messages/object-mode.test.ts`'s own pattern): the
 * route resolves the real `getWorkspaceMail` factory with `FLAGSHIP` pinned
 * to `object-only` and the C2 fakes
 * (`@weldsuite/mail-domain/store/object/testing/fake-env`) for
 * `MAILBOX_STORE`, rather than hand-mocking the route's own seam.
 *
 * Before this fix, every AI endpoint that takes a `messageId`
 * (`smart-replies`, `label`, `label/batch`, `reply`) answered 404 in
 * `object-only`: the access pre-check loaded the message from a direct
 * `mail_messages` row that mode never populates. These tests ingest a
 * message straight into the fake mailbox stub — zero Postgres mail rows —
 * and prove the route finds it anyway, through `store.locateMessages` +
 * `access.canOpen` (`loadMessage`'s object-mode fallback,
 * `services/mail/ai.ts`).
 */

const ai = vi.hoisted(() => ({ generateText: vi.fn(), generateObject: vi.fn() }));

vi.mock('@weldsuite/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/ai')>()),
  assertGatewayConfigured: vi.fn(),
  createWeldAI: () => ({ model: (id: string) => id }),
  generateText: ai.generateText,
  generateObject: ai.generateObject,
}));

vi.mock('@weldsuite/core-domain/ai-billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/core-domain/ai-billing')>()),
  resolveAiMetering: vi.fn(async () => null),
}));

vi.mock('@weldsuite/entity-events', () => ({ publishEntityEvent: vi.fn() }));

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mailAiRoutes } from './index';
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
import { ObjectMailboxStore } from '@weldsuite/mail-domain/store/object';
import type { IngestMessage, MailboxRef } from '@weldsuite/mail-domain/store';
import type { Env, Variables } from '../../types';

const { mailAccounts, mailMessages, workspaceMembers } = schema;

const USER = 'user_1';
const STRANGER = 'user_stranger';
const WORKSPACE_ID = 'ws_ai_object_only';
const ORG_ID = 'org_ai_object_only';

let db: Database;
let accountId: string;
let privateAccountId: string;

function makeIngest(overrides: Partial<IngestMessage> = {}): IngestMessage {
  const id = overrides.id ?? generateId('mmsg');
  const now = Date.now();
  return {
    id,
    source: 'inbound',
    rfcMessageId: `<${id}@test.dev>`,
    threadId: null,
    from: { email: 'sender@example.com', name: 'Sender' },
    to: [{ email: 'me@test.dev' }],
    subject: 'Object-only AI test',
    preview: 'preview text',
    sentAt: now,
    receivedAt: now,
    createdAt: now,
    isRead: false,
    labels: ['INBOX'],
    isSpam: false,
    isReply: false,
    content: { html: null, text: 'the full message body' },
    attachments: [],
    ...overrides,
  };
}

/**
 * Ingests through the `ObjectMailboxStore` client (not the raw DO stub): the
 * client writes body content to R2 itself as part of `apply({kind:'ingest'})`
 * (design decision 4 — bodies live in R2, not the DO's own storage), so a
 * prompt that needs body text has to go in this way, sharing the same
 * `bucket` the app's `MAIL_STORAGE` binding reads from.
 */
async function ingest(mailbox: ReturnType<typeof createFakeMailboxNamespace>, bucket: R2Bucket, ref: MailboxRef, message: IngestMessage) {
  const store = new ObjectMailboxStore({ MAILBOX_STORE: mailbox.namespace, MAIL_STORAGE: bucket }, ref);
  await store.apply({ kind: 'ingest', message }, message.sentAt);
}

function makeApp(userId: string, mailbox: ReturnType<typeof createFakeMailboxNamespace>, bucket: R2Bucket) {
  return createTestApp<Env, Variables>('/api/mail-ai', mailAiRoutes, {
    context: {
      userId,
      tenantDb: db,
      workspaceId: WORKSPACE_ID,
      clerkOrgId: ORG_ID,
      permissions: permissions('messages:read', 'messages:create', 'messages:update'),
    },
    env: {
      FLAGSHIP: createFixedModeFlagship('object-only') as unknown as Env['FLAGSHIP'],
      WORKSPACE_CACHE: createMemoryKv(),
      MAILBOX_STORE: mailbox.namespace,
      MAIL_STORAGE: bucket as unknown as Env['MAIL_STORAGE'],
    } as Partial<Env>,
  });
}

function post(
  userId: string,
  mailbox: ReturnType<typeof createFakeMailboxNamespace>,
  bucket: R2Bucket,
  path: string,
  body: unknown,
) {
  const { request } = makeApp(userId, mailbox, bucket);
  return request(`/api/mail-ai${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Everything the stubbed model was sent, as one string. */
function promptsSent(): string {
  return JSON.stringify([...ai.generateText.mock.calls, ...ai.generateObject.mock.calls]);
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
  ai.generateText.mockReset().mockResolvedValue({ text: 'generated', usage: {} });
  ai.generateObject.mockReset().mockResolvedValue({
    object: { subject: 's', body: 'b', replies: ['ok'], category: 'sales', priority: 'normal' },
    usage: {},
  });
});

afterEach(() => {
  __resetMailRouterStateForTests();
  __resetMailStoreModeCacheForTests();
});

describe('object-only mode: /api/mail-ai/* message lookups', () => {
  it('answers /smart-replies for a message with zero Postgres mail rows', async () => {
    const mailbox = createFakeMailboxNamespace();
    const bucket = createMemoryR2();
    const ref: MailboxRef = { workspaceId: WORKSPACE_ID, accountId, clerkOrgId: ORG_ID };
    const message = makeIngest();
    await ingest(mailbox, bucket, ref, message);

    const pgRows = await db.select({ id: mailMessages.id }).from(mailMessages);
    expect(pgRows).toHaveLength(0);

    const res = await post(USER, mailbox, bucket, '/smart-replies', { messageId: message.id });
    expect(res.status).toBe(200);
    expect(promptsSent()).toContain('the full message body');
  });

  it('answers /label and persists the classification through the object store', async () => {
    const mailbox = createFakeMailboxNamespace();
    const bucket = createMemoryR2();
    const ref: MailboxRef = { workspaceId: WORKSPACE_ID, accountId, clerkOrgId: ORG_ID };
    const message = makeIngest();
    await ingest(mailbox, bucket, ref, message);

    const res = await post(USER, mailbox, bucket, '/label', { messageId: message.id });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { category: string } };
    expect(json.data.category).toBe('sales');
  });

  it('answers /reply using the object-stored message as context', async () => {
    const mailbox = createFakeMailboxNamespace();
    const bucket = createMemoryR2();
    const ref: MailboxRef = { workspaceId: WORKSPACE_ID, accountId, clerkOrgId: ORG_ID };
    const message = makeIngest({ subject: 'Reply target subject' });
    await ingest(mailbox, bucket, ref, message);

    const res = await post(USER, mailbox, bucket, '/reply', { messageId: message.id });
    expect(res.status).toBe(200);
    expect(promptsSent()).toContain('Reply target subject');
  });

  it('still answers 404 for a message that does not exist anywhere', async () => {
    const mailbox = createFakeMailboxNamespace();
    const bucket = createMemoryR2();
    const res = await post(USER, mailbox, bucket, '/smart-replies', { messageId: 'mmsg_missing' });
    expect(res.status).toBe(404);
  });

  it('collapses to 404 (not 403) for a message in a mailbox the caller cannot open', async () => {
    const mailbox = createFakeMailboxNamespace();
    const bucket = createMemoryR2();
    const ref: MailboxRef = { workspaceId: WORKSPACE_ID, accountId: privateAccountId, clerkOrgId: ORG_ID };
    const message = makeIngest();
    await ingest(mailbox, bucket, ref, message);

    const res = await post(STRANGER, mailbox, bucket, '/smart-replies', { messageId: message.id });
    expect(res.status).toBe(404);
  });
});

describe('object-only mode: POST /api/mail-ai/inbox-summary', () => {
  it('summarises recent mail read from the object store, with zero Postgres mail rows', async () => {
    const mailbox = createFakeMailboxNamespace();
    const bucket = createMemoryR2();
    const ref: MailboxRef = { workspaceId: WORKSPACE_ID, accountId, clerkOrgId: ORG_ID };
    const message = makeIngest({ subject: 'Fresh inbox item', preview: 'needs a reply' });
    await ingest(mailbox, bucket, ref, message);

    const pgRows = await db.select({ id: mailMessages.id }).from(mailMessages);
    expect(pgRows).toHaveLength(0);

    const res = await post(USER, mailbox, bucket, '/inbox-summary', { accountId });
    expect(res.status).toBe(200);
    expect(promptsSent()).toContain('Fresh inbox item');
  });
});
