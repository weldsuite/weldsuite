/**
 * Ensures WeldMail mutation routes that move/update messages fan out
 * `email` entity events for live cross-screen sync.
 *
 * Runs against a real pglite tenant DB, like `access.test.ts` (see that
 * file's header comment for why: the route now resolves
 * `workspaceMailFromContext` once per request, which imports
 * `@weldsuite/mail-domain/store/directory` — a module that destructures
 * `schema.mailLabels`/`mailAccounts` columns at import time, so this file's
 * old partial `schema` mock threw before any test body ran).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mailMessagesRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';

vi.mock('@weldsuite/mail-domain/send', () => ({
  replyAndPersist: vi.fn(),
  forwardAndPersist: vi.fn(),
  MailSendError: class MailSendError extends Error {
    constructor(public readonly code: string, public readonly message: string, public readonly details?: unknown) {
      super(message);
    }
  },
}));

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn() };
});

import { publishEntityEvent } from '@weldsuite/entity-events';

const { mailAccounts, mailMessages, workspaceMembers } = schema;

const mockedPublish = publishEntityEvent as ReturnType<typeof vi.fn>;

const USER_ID = 'user_1';

let db: Database;
let sharedAccountId: string;
let privateAccountId: string;

async function seedMessage(accountId: string, overrides: Partial<typeof mailMessages.$inferInsert> = {}): Promise<string> {
  const id = generateId('mmsg');
  await db.insert(mailMessages).values({
    id,
    accountId,
    threadId: `thread_${id}`,
    messageId: `<${id}@test.dev>`,
    from: { email: 'hr@example.com', name: 'HR' },
    to: [{ email: 'candidate@example.com' }],
    subject: 'Offer letter',
    sentDate: new Date(),
    labels: ['INBOX'],
    isRead: false,
    ...overrides,
  });
  return id;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(workspaceMembers).values({
    id: generateId('wm'),
    userId: USER_ID,
    email: `${USER_ID}@test.dev`,
    role: 'ADMIN',
  } as typeof workspaceMembers.$inferInsert);

  sharedAccountId = generateId('mail');
  await db.insert(mailAccounts).values({ id: sharedAccountId, name: 'Shared', email: `${sharedAccountId}@test.dev`, isShared: true });

  privateAccountId = generateId('mail');
  await db.insert(mailAccounts).values({
    id: privateAccountId,
    name: 'Private',
    email: `${privateAccountId}@test.dev`,
    isShared: false,
    assignedUserIds: [],
  });
}, 60_000);

function makeApp() {
  return createTestApp('/api/mail-messages', mailMessagesRoutes, {
    context: {
      userId: USER_ID,
      tenantDb: db,
      permissions: permissions('messages:read', 'messages:create', 'messages:update', 'messages:delete'),
    },
  });
}

beforeEach(() => {
  mockedPublish.mockClear();
});

describe('mail-messages realtime publish', () => {
  it('publishes email:updated on bulk actions', async () => {
    const id1 = await seedMessage(sharedAccountId);
    const id2 = await seedMessage(sharedAccountId);

    const { request } = makeApp();
    const res = await request('/api/mail-messages/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageIds: [id1, id2], action: 'trash' }),
    });

    expect(res.status).toBe(200);
    expect(mockedPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'email',
        entityId: id1,
        action: 'updated',
        data: expect.objectContaining({ id: id1, accountId: sharedAccountId }),
      }),
    );
  });

  it('publishes email:deleted on bulk delete', async () => {
    const id = await seedMessage(sharedAccountId);

    const { request } = makeApp();
    const res = await request('/api/mail-messages/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageIds: [id], action: 'delete' }),
    });

    expect(res.status).toBe(200);
    expect(mockedPublish).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'email', action: 'deleted' }),
    );
  });

  it('publishes email:updated on label add/remove', async () => {
    const id = await seedMessage(sharedAccountId);
    const { request } = makeApp();

    const addRes = await request(`/api/mail-messages/${id}/labels/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels: ['STARRED'] }),
    });
    expect(addRes.status).toBe(200);
    expect(mockedPublish).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'email', entityId: id, action: 'updated' }),
    );

    mockedPublish.mockClear();

    const removeRes = await request(`/api/mail-messages/${id}/labels/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels: ['STARRED'] }),
    });
    expect(removeRes.status).toBe(200);
    expect(mockedPublish).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'email', entityId: id, action: 'updated' }),
    );
  });
});

// The event is workspace-wide, so whatever a route knows about the message has
// to pass through `emailEventData` (which clears it for a private mailbox)
// before it is published. These pin that the routes publish the gate's output,
// never the raw row — using a REAL private (not-shared) account so the real
// `emailEventData` redacts it, same as it would for any other private mailbox.
describe('mail-messages event payload for a private mailbox', () => {
  const SECRETS = ['Offer letter', 'hr@example.com', 'candidate@example.com'];

  function publishedPayloads(): string {
    return JSON.stringify(mockedPublish.mock.calls.map(([params]) => (params as { data: unknown }).data));
  }

  it('publishes no subject, sender or recipients on update', async () => {
    const id = await seedMessage(privateAccountId);
    const { request } = makeApp();
    const res = await request(`/api/mail-messages/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isRead: true }),
    });

    expect(res.status).toBe(200);
    expect(mockedPublish).toHaveBeenCalledTimes(1);
    expect(mockedPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'email',
        action: 'updated',
        data: { id, accountId: privateAccountId, subject: null, from: null, to: null },
      }),
    );
    for (const secret of SECRETS) expect(publishedPayloads()).not.toContain(secret);
  });

  it('publishes no subject on delete', async () => {
    const id = await seedMessage(privateAccountId);
    const { request } = makeApp();
    const res = await request(`/api/mail-messages/${id}`, { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(mockedPublish).toHaveBeenCalledTimes(1);
    expect(mockedPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'email',
        action: 'deleted',
        data: { id, accountId: privateAccountId, subject: null, from: null, to: null },
      }),
    );
    for (const secret of SECRETS) expect(publishedPayloads()).not.toContain(secret);
  });
});
