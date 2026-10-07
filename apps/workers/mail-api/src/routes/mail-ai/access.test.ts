/**
 * pglite-backed access tests for /api/mail-ai/*.
 *
 * The route permission (`messages:*`) says the caller may use mail AI; it
 * does not say which mailboxes they may read. Every endpoint takes an
 * `accountId` and/or message ids from the body, so each has to refuse a
 * private mailbox the caller is not assigned to — admins and owners included
 * — before anything reaches the model. The model itself is stubbed: the
 * prompt it would have received is what these tests inspect.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

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

import { mailAiRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';

const { mailAccounts, mailMessages, workspaceMembers } = schema;

const ADMIN = 'user_admin';
const OWNER = 'user_owner';
const ASSIGNEE = 'user_assignee';
const MEMBER = 'user_member';

const SHARED_SUBJECT = 'Team lunch on Friday';
const PRIVATE_SUBJECT = 'Salary review for Q4';
const UNASSIGNED_SUBJECT = 'Orphaned mailbox notice';

const DENIED = 'Access to this mail account is not allowed';

let db: Database;
let shared: string;
let privateAssigned: string;
let privateUnassigned: string;
let sharedMessage: string;
let privateMessage: string;

async function seedMember(userId: string, role: string) {
  const now = new Date();
  await db.insert(workspaceMembers).values({
    id: generateId('wm'),
    userId,
    email: `${userId}@test.dev`,
    role,
    createdAt: now,
    updatedAt: now,
  } as typeof workspaceMembers.$inferInsert);
}

async function seedAccount(values: Partial<typeof mailAccounts.$inferInsert>): Promise<string> {
  const id = generateId('mail');
  await db.insert(mailAccounts).values({ id, name: 'Test', email: `${id}@test.dev`, ...values });
  return id;
}

async function seedMessage(accountId: string, subject: string): Promise<string> {
  const id = generateId('mmsg');
  await db.insert(mailMessages).values({
    id,
    accountId,
    threadId: `thread_${id}`,
    messageId: `<${id}@test.dev>`,
    from: { email: 'sender@example.com', name: 'Sender' },
    to: [{ email: 'me@test.dev' }],
    subject,
    preview: `Preview of ${subject}`,
    textBody: `Body of ${subject}`,
    sentDate: new Date(),
    labels: ['INBOX'],
  });
  return id;
}

function post(userId: string, path: string, body: unknown) {
  const { request } = createTestApp('/api/mail-ai', mailAiRoutes, {
    context: {
      userId,
      tenantDb: db,
      permissions: permissions('messages:read', 'messages:create', 'messages:update'),
    },
  });
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

async function categoriesOf(messageId: string): Promise<string[]> {
  const [row] = await db
    .select({ categories: mailMessages.categories })
    .from(mailMessages)
    .where(eq(mailMessages.id, messageId))
    .limit(1);
  return (row?.categories as string[] | null) ?? [];
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;

  await seedMember(ADMIN, 'ADMIN');
  await seedMember(OWNER, 'OWNER');
  await seedMember(ASSIGNEE, 'MEMBER');
  await seedMember(MEMBER, 'MEMBER');

  shared = await seedAccount({ isShared: true });
  privateAssigned = await seedAccount({ isShared: false, assignedUserIds: [ASSIGNEE] });
  privateUnassigned = await seedAccount({ isShared: false, assignedUserIds: null });

  sharedMessage = await seedMessage(shared, SHARED_SUBJECT);
  privateMessage = await seedMessage(privateAssigned, PRIVATE_SUBJECT);
  await seedMessage(privateUnassigned, UNASSIGNED_SUBJECT);
}, 60_000);

beforeEach(() => {
  ai.generateText.mockReset().mockResolvedValue({ text: 'generated', usage: {} });
  ai.generateObject.mockReset().mockResolvedValue({
    object: { subject: 's', body: 'b', replies: ['ok'], category: 'other', priority: 'normal' },
    usage: {},
  });
});

/** One request per way a private mailbox can be named in a body. */
const privateMailboxRequests: [string, string, () => unknown][] = [
  ['/draft by accountId', '/draft', () => ({ prompt: 'hi', accountId: privateAssigned })],
  ['/draft by replyToMessageId', '/draft', () => ({ prompt: 'hi', replyToMessageId: privateMessage })],
  ['/improve-text by accountId', '/improve-text', () => ({ text: 'hi', action: 'improve', accountId: privateAssigned })],
  ['/auto-draft by accountId', '/auto-draft', () => ({ accountId: privateAssigned })],
  ['/auto-draft by messageId', '/auto-draft', () => ({ accountId: shared, messageId: privateMessage })],
  [
    '/auto-draft by recentMessageIds',
    '/auto-draft',
    () => ({ accountId: shared, recentMessageIds: [sharedMessage, privateMessage] }),
  ],
  ['/reply by messageId', '/reply', () => ({ messageId: privateMessage })],
  ['/reply by accountId', '/reply', () => ({ accountId: privateAssigned })],
  ['/smart-replies', '/smart-replies', () => ({ messageId: privateMessage })],
  ['/inbox-summary by accountId', '/inbox-summary', () => ({ accountId: privateAssigned })],
  ['/label', '/label', () => ({ messageId: privateMessage })],
];

describe('a private mailbox the caller is not assigned to', () => {
  it.each(privateMailboxRequests)('%s is refused to a member', async (_name, path, body) => {
    const res = await post(MEMBER, path, body());
    expect(res.status).toBe(403);
    const json = (await res.json()) as { success: boolean; error: { code: string; message: string } };
    expect(json.success).toBe(false);
    expect(json.error).toEqual({ code: 'forbidden', message: DENIED });
    expect(ai.generateText).not.toHaveBeenCalled();
    expect(ai.generateObject).not.toHaveBeenCalled();
  });

  it.each(privateMailboxRequests)('%s is refused to an admin and an owner', async (_name, path, body) => {
    expect((await post(ADMIN, path, body())).status).toBe(403);
    expect((await post(OWNER, path, body())).status).toBe(403);
    expect(ai.generateText).not.toHaveBeenCalled();
    expect(ai.generateObject).not.toHaveBeenCalled();
  });

  it('/label/batch refuses the whole batch and classifies nothing', async () => {
    const res = await post(MEMBER, '/label/batch', { messageIds: [sharedMessage, privateMessage] });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toBe('Access to one or more mail accounts is not allowed');
    expect(ai.generateObject).not.toHaveBeenCalled();
    expect(await categoriesOf(sharedMessage)).toEqual([]);
    expect(await categoriesOf(privateMessage)).toEqual([]);
  });
});

describe('a mailbox the caller may open', () => {
  it.each(privateMailboxRequests)('%s works for the assignee', async (_name, path, body) => {
    const res = await post(ASSIGNEE, path, body());
    expect(res.status).toBe(200);
  });

  it('lets the assignee reply to a private message, with its content as context', async () => {
    const res = await post(ASSIGNEE, '/reply', { messageId: privateMessage });
    expect(res.status).toBe(200);
    expect(promptsSent()).toContain(PRIVATE_SUBJECT);
  });

  it('lets any member use a shared mailbox', async () => {
    expect((await post(MEMBER, '/smart-replies', { messageId: sharedMessage })).status).toBe(200);
    expect((await post(MEMBER, '/inbox-summary', { accountId: shared })).status).toBe(200);
  });

  it('opens an unassigned private mailbox to admins only', async () => {
    expect((await post(ADMIN, '/inbox-summary', { accountId: privateUnassigned })).status).toBe(200);
    expect((await post(MEMBER, '/inbox-summary', { accountId: privateUnassigned })).status).toBe(403);
  });

  it('still answers 404 for a message that does not exist', async () => {
    const res = await post(MEMBER, '/smart-replies', { messageId: 'mmsg_missing' });
    expect(res.status).toBe(404);
  });

  it('classifies a batch the caller may read and skips missing ids', async () => {
    const res = await post(MEMBER, '/label/batch', { messageIds: [sharedMessage, 'mmsg_missing'] });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { results: { messageId: string }[] } };
    expect(json.data.results.map((r) => r.messageId)).toEqual([sharedMessage]);
    expect(await categoriesOf(sharedMessage)).toEqual(['ai:other']);
  });
});

describe('POST /inbox-summary without an accountId', () => {
  it('summarises only shared mailboxes for an unassigned member', async () => {
    const res = await post(MEMBER, '/inbox-summary', {});
    expect(res.status).toBe(200);
    const sent = promptsSent();
    expect(sent).toContain(SHARED_SUBJECT);
    expect(sent).not.toContain(PRIVATE_SUBJECT);
    expect(sent).not.toContain(UNASSIGNED_SUBJECT);
  });

  it('includes a private mailbox for its assignee', async () => {
    await post(ASSIGNEE, '/inbox-summary', {});
    const sent = promptsSent();
    expect(sent).toContain(SHARED_SUBJECT);
    expect(sent).toContain(PRIVATE_SUBJECT);
    expect(sent).not.toContain(UNASSIGNED_SUBJECT);
  });

  it('gives an admin the unassigned mailbox but not a colleague\'s private one', async () => {
    await post(ADMIN, '/inbox-summary', {});
    const sent = promptsSent();
    expect(sent).toContain(SHARED_SUBJECT);
    expect(sent).toContain(UNASSIGNED_SUBJECT);
    expect(sent).not.toContain(PRIVATE_SUBJECT);
  });
});
