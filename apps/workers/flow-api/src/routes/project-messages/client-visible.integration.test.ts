/**
 * DB-backed tests for the client-portal flag on project messages (FLOW-020):
 * PATCH /api/project-messages/:id with `clientVisible`. The sender, or a
 * project admin for this one field, may change it. Runs against the
 * TypeScript worker and, in conformance mode, the Rust backend.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { projectMessagesRoutes } from './index';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const MANAGER = 'user_cvm_manager';
const SENDER = 'user_cvm_sender';
const OTHER = 'user_cvm_other';
const VIEWER = 'user_cvm_viewer';
const PROJECT = 'prj_cvm';
const KEYS = ['projects:read', 'projects:update'];

let db: Database;

type Send = (method: string, path: string, body?: unknown) => Promise<Response>;

function as(userId: string, keys: string[] = KEYS): Send {
  const { request } = createTestApp('/api/project-messages', projectMessagesRoutes, {
    context: { userId, permissions: permissions(...keys), tenantDb: db },
  });
  return (method, path, body) =>
    request(`/api/project-messages${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

const published = vi.mocked(publishEntityEvent);
const events = () => published.mock.calls.map(([event]) => event);

async function visibleOf(id: string) {
  const [row] = await db.select().from(schema.projectMessages).where(eq(schema.projectMessages.id, id)).limit(1);
  return row?.clientVisible;
}

async function seedMessage(id: string, senderId = SENDER) {
  const now = new Date('2026-11-01T09:00:00.000Z');
  await db.insert(schema.projectMessages).values({
    id, projectId: PROJECT, conversationId: PROJECT, senderId, message: 'Hello', messageType: 'text',
    isRead: false, createdAt: now, updatedAt: now,
  } as unknown as typeof schema.projectMessages.$inferInsert);
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const now = new Date('2026-11-01T08:00:00.000Z');
  await db.insert(schema.projects).values({ id: PROJECT, name: PROJECT, projectManagerId: MANAGER, createdAt: now, updatedAt: now });
  await db.insert(schema.projectMembers).values(
    [
      { id: 'pm_cvm_s', userId: SENDER, role: 'member' },
      { id: 'pm_cvm_o', userId: OTHER, role: 'member' },
      { id: 'pm_cvm_v', userId: VIEWER, role: 'viewer' },
    ].map((m) => ({ ...m, projectId: PROJECT, isActive: true, createdAt: now, updatedAt: now, joinedAt: now })),
  );
}, 60_000);

beforeEach(() => {
  published.mockClear();
});

describe('PATCH /:id clientVisible', () => {
  it('lets the sender share and unshare, answering the patch and publishing project_message.updated', async () => {
    await seedMessage('pmsg_cvm_own');
    const res = await as(SENDER)('PATCH', '/pmsg_cvm_own', { clientVisible: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ id: 'pmsg_cvm_own', clientVisible: true });
    expect(await visibleOf('pmsg_cvm_own')).toBe(true);
    expect(events().map((e) => `${e.entityType}.${e.action}`)).toEqual(['project_message.updated']);
    expect(events()[0]?.data).toEqual({ id: 'pmsg_cvm_own', clientVisible: true });

    const off = await as(SENDER)('PATCH', '/pmsg_cvm_own', { clientVisible: false });
    expect(off.status).toBe(200);
    expect(await visibleOf('pmsg_cvm_own')).toBe(false);
  });

  it('lets a project admin share a message written by someone else', async () => {
    await seedMessage('pmsg_cvm_admin');
    const res = await as(MANAGER)('PATCH', '/pmsg_cvm_admin', { clientVisible: true });
    expect(res.status).toBe(200);
    expect(await visibleOf('pmsg_cvm_admin')).toBe(true);
  });

  it('keeps editing text for the sender only, even for an admin', async () => {
    await seedMessage('pmsg_cvm_text');
    const res = await as(MANAGER)('PATCH', '/pmsg_cvm_text', { message: 'Edited', clientVisible: true });
    expect(res.status).toBe(403);
    const error = ((await res.json()) as { error: { message: string } }).error;
    expect(error.message).toBe('You can only edit your own messages');
    expect(await visibleOf('pmsg_cvm_text')).toBe(false);
  });

  it('denies another plain member', async () => {
    await seedMessage('pmsg_cvm_member');
    const res = await as(OTHER)('PATCH', '/pmsg_cvm_member', { clientVisible: true });
    expect(res.status).toBe(403);
    expect(await visibleOf('pmsg_cvm_member')).toBe(false);
    expect(events()).toEqual([]);
  });

  it('denies a viewer, even on their own message', async () => {
    await seedMessage('pmsg_cvm_viewer', VIEWER);
    const res = await as(VIEWER)('PATCH', '/pmsg_cvm_viewer', { clientVisible: true });
    expect(res.status).toBe(403);
    const error = ((await res.json()) as { error: { message: string } }).error;
    expect(error.message).toBe('You do not have write access to this project');
    expect(await visibleOf('pmsg_cvm_viewer')).toBe(false);
  });

  it('answers 404 for an unknown message and 400 for a non-boolean flag', async () => {
    expect((await as(SENDER)('PATCH', '/pmsg_cvm_missing', { clientVisible: true })).status).toBe(404);
    await seedMessage('pmsg_cvm_bad');
    expect((await as(SENDER)('PATCH', '/pmsg_cvm_bad', { clientVisible: 'yes' })).status).toBe(400);
  });
});
