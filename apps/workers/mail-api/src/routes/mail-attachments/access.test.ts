/**
 * pglite-backed tests for /api/mail-attachments (TASK-905).
 *
 * - No response carries `storagePath` or `downloadUrl`: the bucket's public URL
 *   serves a file without authentication, so the API never hands it out.
 * - `GET /:id/download` is the only way to the bytes, answers 404 (not 403) for
 *   an attachment of a mailbox the caller cannot open, and never serves a key
 *   outside the workspace's folder.
 * - Both of the workspace's folders count as its own: compose uploads under the
 *   Clerk org id, inbound mail under the master workspace id (`ws_…`).
 * - `POST /` and `PATCH /:id` refuse a storagePath outside the workspace, and
 *   `POST /associate` cannot move an attachment out of a private mailbox.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';

import { mailAttachmentsRoutes } from './index';
import { mailMessagesRoutes } from '../mail-messages';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';

// The harness defaults: the master workspace id and the Clerk org id of the request.
const WS = 'ws_test_default';

const { mailAccounts, mailAttachments, mailMessages, workspaceMembers } = schema;

const ORG = 'org_test_default';
const ASSIGNEE = 'user_assignee';
const MEMBER = 'user_member';
const PUBLIC_URL = 'https://weldsuite-storage.weldsuite.org';

const OWN_KEY = `workspaces/${ORG}/mail/attachments/msg/1_report.txt`;
const FOREIGN_KEY = 'workspaces/org_other/mail/attachments/msg/1_secret.txt';
// Where mail-inbound-worker stores a received attachment.
const INBOUND_KEY = `workspaces/${WS}/mail/attachments/msg/1_inbound-note.txt`;
const FOREIGN_INBOUND_KEY = 'workspaces/ws_other/mail/attachments/msg/1_secret.txt';

let db: Database;
let sharedMessage: string;
let privateMessage: string;
let sharedAttachment: string;
let privateAttachment: string;
let foreignKeyAttachment: string;
let missingObjectAttachment: string;
let inboundAttachment: string;
let foreignInboundAttachment: string;

const objects = new Map<string, string>([
  [OWN_KEY, 'hello shared'],
  [`workspaces/${ORG}/mail/attachments/msg/2_private.txt`, 'hello private'],
  [FOREIGN_KEY, 'other workspace'],
  [INBOUND_KEY, 'hello inbound'],
  [FOREIGN_INBOUND_KEY, 'other workspace inbound'],
]);

// A real (memory) bucket, so the conformance harness can share it with Rust.
const storage = createMemoryR2();

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

async function seedMessage(accountId: string): Promise<string> {
  const id = generateId('mmsg');
  await db.insert(mailMessages).values({
    id,
    accountId,
    threadId: `thread_${id}`,
    messageId: `<${id}@test.dev>`,
    from: { email: 'sender@example.com', name: 'Sender' },
    to: [{ email: 'me@test.dev' }],
    subject: 'Attachment test',
    sentDate: new Date(),
    labels: ['INBOX'],
    hasAttachments: true,
  });
  return id;
}

async function seedAttachment(messageId: string, storagePath: string | null): Promise<string> {
  const id = generateId('attach');
  await db.insert(mailAttachments).values({
    id,
    messageId,
    fileName: 'report.txt',
    contentType: 'text/plain',
    size: 12,
    storagePath,
    downloadUrl: storagePath ? `${PUBLIC_URL}/${storagePath}` : null,
  });
  return id;
}

function api<T extends 'attachments' | 'messages'>(userId: string, which: T = 'attachments' as T) {
  const router = (which === 'attachments' ? mailAttachmentsRoutes : mailMessagesRoutes) as never;
  const base = which === 'attachments' ? '/api/mail-attachments' : '/api/mail-messages';
  const { request } = createTestApp<Env, Variables>(base, router, {
    context: {
      userId,
      tenantDb: db,
      permissions: permissions('messages:read', 'messages:create', 'messages:update'),
    },
    env: { STORAGE: storage } as Partial<Env>,
  });
  return (path: string, init?: RequestInit) => request(`${base}${path}`, init);
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  for (const [key, body] of objects) await storage.put(key, body, { httpMetadata: { contentType: 'text/plain' } });
  await seedMember(ASSIGNEE, 'MEMBER');
  await seedMember(MEMBER, 'MEMBER');

  const shared = await seedAccount({ isShared: true });
  const privateAccount = await seedAccount({ isShared: false, assignedUserIds: [ASSIGNEE] });
  sharedMessage = await seedMessage(shared);
  privateMessage = await seedMessage(privateAccount);

  sharedAttachment = await seedAttachment(sharedMessage, OWN_KEY);
  privateAttachment = await seedAttachment(privateMessage, `workspaces/${ORG}/mail/attachments/msg/2_private.txt`);
  foreignKeyAttachment = await seedAttachment(sharedMessage, FOREIGN_KEY);
  missingObjectAttachment = await seedAttachment(sharedMessage, `workspaces/${ORG}/mail/attachments/msg/gone.txt`);
  inboundAttachment = await seedAttachment(sharedMessage, INBOUND_KEY);
  foreignInboundAttachment = await seedAttachment(sharedMessage, FOREIGN_INBOUND_KEY);
}, 60_000);

describe('responses never carry the storage URL', () => {
  it('GET /message/:id', async () => {
    const res = await api(MEMBER)(`/message/${sharedMessage}`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(data.length).toBeGreaterThan(0);
    for (const row of data) {
      expect(row).not.toHaveProperty('downloadUrl');
      expect(row).not.toHaveProperty('storagePath');
      expect(row).toMatchObject({ fileName: 'report.txt' });
    }
    expect(JSON.stringify(data)).not.toContain('weldsuite-storage');
  });

  it('GET /:id', async () => {
    const res = await api(MEMBER)(`/${sharedAttachment}`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({ id: sharedAttachment, fileName: 'report.txt' });
    expect(data).not.toHaveProperty('downloadUrl');
    expect(data).not.toHaveProperty('storagePath');
  });

  it('GET /api/mail-messages/:id (the attachments of a message)', async () => {
    const res = await api(MEMBER, 'messages')(`/${sharedMessage}`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { attachments: Array<Record<string, unknown>> } };
    expect(data.attachments.length).toBeGreaterThan(0);
    for (const row of data.attachments) {
      expect(row).not.toHaveProperty('downloadUrl');
      expect(row).not.toHaveProperty('storagePath');
    }
  });

  it('POST / stores the row but does not echo the path', async () => {
    const res = await api(MEMBER)('', json({ messageId: sharedMessage, fileName: 'new.txt', size: 3, storagePath: OWN_KEY }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).not.toHaveProperty('storagePath');
    expect(data).not.toHaveProperty('downloadUrl');
  });

  it('PATCH /:id', async () => {
    const res = await api(MEMBER)(`/${sharedAttachment}`, { ...json({ fileName: 'renamed.txt' }), method: 'PATCH' });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({ fileName: 'renamed.txt' });
    expect(data).not.toHaveProperty('storagePath');
    expect(data).not.toHaveProperty('downloadUrl');
  });
});

describe('GET /:id/download', () => {
  it('serves the bytes as a download to a member of the mailbox', async () => {
    const res = await api(MEMBER)(`/${sharedAttachment}/download`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello shared');
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it("answers 404 for an attachment of a private mailbox the caller cannot open", async () => {
    const res = await api(MEMBER)(`/${privateAttachment}/download`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('hello private');
    // The assignee reads it.
    const own = await api(ASSIGNEE)(`/${privateAttachment}/download`);
    expect(own.status).toBe(200);
    expect(await own.text()).toBe('hello private');
  });

  it('answers 404 for an unknown attachment, just like the private one', async () => {
    expect((await api(MEMBER)('/attach_missing/download')).status).toBe(404);
  });

  it('answers 404 on GET /:id of a private mailbox too', async () => {
    expect((await api(MEMBER)(`/${privateAttachment}`)).status).toBe(404);
  });

  it("never serves a key outside the workspace's folder", async () => {
    const res = await api(MEMBER)(`/${foreignKeyAttachment}/download`);
    expect(res.status).toBe(404);
  });

  it('serves a received attachment stored under the master workspace id', async () => {
    const res = await api(MEMBER)(`/${inboundAttachment}/download`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello inbound');
  });

  it("never serves another workspace's inbound folder", async () => {
    expect((await api(MEMBER)(`/${foreignInboundAttachment}/download`)).status).toBe(404);
  });

  it('answers 404 when the object is gone', async () => {
    expect((await api(MEMBER)(`/${missingObjectAttachment}/download`)).status).toBe(404);
  });

  it("answers 404 for an attachment whose owning message has since been soft-deleted, even though the attachment row itself has no deletedAt", async () => {
    const key = `workspaces/${ORG}/mail/attachments/msg/3_softdeleted.txt`;
    await storage.put(key, 'hello soft-deleted');
    const account = await seedAccount({ isShared: true });
    const message = await seedMessage(account);
    const attachment = await seedAttachment(message, key);

    // Reachable before the message is deleted — sanity check this isn't 404 for some other reason.
    expect((await api(MEMBER)(`/${attachment}`)).status).toBe(200);
    expect((await api(MEMBER)(`/${attachment}/download`)).status).toBe(200);

    await db.update(mailMessages).set({ deletedAt: new Date() }).where(eq(mailMessages.id, message));

    expect((await api(MEMBER)(`/${attachment}`)).status).toBe(404);
    expect((await api(MEMBER)(`/${attachment}/download`)).status).toBe(404);
  });
});

describe('storagePath is confined to the workspace', () => {
  it('POST / refuses a key of another workspace or a path with ..', async () => {
    for (const storagePath of [FOREIGN_KEY, FOREIGN_INBOUND_KEY, `workspaces/${ORG}/../org_other/x`, 'personal/p1/x']) {
      const res = await api(MEMBER)('', json({ messageId: sharedMessage, fileName: 'x.txt', size: 1, storagePath }));
      expect(res.status).toBe(400);
    }
  });

  it("POST / accepts a key in the workspace's inbound folder", async () => {
    const res = await api(MEMBER)('', json({ messageId: sharedMessage, fileName: 'in.txt', size: 1, storagePath: INBOUND_KEY }));
    expect(res.status).toBe(201);
  });

  it('PATCH /:id refuses it too', async () => {
    const res = await api(MEMBER)(`/${sharedAttachment}`, { ...json({ storagePath: FOREIGN_KEY }), method: 'PATCH' });
    expect(res.status).toBe(400);
  });
});

describe('POST /associate', () => {
  it('moves an attachment of a mailbox the caller can open', async () => {
    const own = await seedAttachment(sharedMessage, OWN_KEY);
    const res = await api(MEMBER)('/associate', json({ messageId: sharedMessage, attachmentIds: [own] }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { associated: number } }).data.associated).toBe(1);
  });

  it('does not move an attachment out of a private mailbox the caller cannot open', async () => {
    const res = await api(MEMBER)('/associate', json({ messageId: sharedMessage, attachmentIds: [privateAttachment] }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { associated: number } }).data.associated).toBe(0);

    const [stillThere] = await db
      .select({ messageId: mailAttachments.messageId })
      .from(mailAttachments)
      .where(eq(mailAttachments.id, privateAttachment));
    expect(stillThere?.messageId).toBe(privateMessage);
  });
});
