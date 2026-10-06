/**
 * WeldConnect contact actions over the internal route, against pglite: the
 * owner's permissions are checked at run time, the people service writes the
 * row and the entity event carries the run's chain depth.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;
const published: Array<Record<string, unknown>> = [];

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getTenantDbForWorkspace: async () => db };
});

vi.mock('@weldsuite/entity-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/entity-events')>();
  return {
    ...actual,
    publishEntityEventRaw: async (event: Record<string, unknown>) => {
      published.push(event);
    },
  };
});

const { internalWorkflowActionsRoutes } = await import('./index');

function app() {
  const root = new Hono<{ Variables: { internalTrusted: boolean } }>();
  root.use('*', async (c, next) => {
    c.set('internalTrusted', true);
    await next();
  });
  root.route('/', internalWorkflowActionsRoutes as never);
  return (path: string, body: unknown) =>
    root.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, {});
}

const actor = (ownerUserId: string) => ({ workspaceId: 'org_1', ownerUserId, triggeredBy: 'system', chainDepth: 1 });

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_member', userId: 'member_1', role: 'MEMBER' },
    { id: 'wm_member2', userId: 'member_2', role: 'MEMBER' },
    { id: 'wm_viewer', userId: 'viewer_1', role: 'VIEWER' },
    { id: 'wm_admin', userId: 'admin_1', role: 'ADMIN' },
  ]);
}, 60_000);

beforeEach(() => {
  published.length = 0;
});

describe('POST /create-contact', () => {
  it('creates the contact as the owner and publishes person:created with the chain depth', async () => {
    const res = await app()('/create-contact', {
      ...actor('member_1'),
      contact: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test', tags: ['vip'] },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { created: boolean; contact: { id: string; displayName: string } };
    expect(body.created).toBe(true);

    const [row] = await db.select().from(schema.people).where(eq(schema.people.id, body.contact.id));
    expect(row).toMatchObject({ firstName: 'Ada', email: 'ada@example.test', ownerId: 'member_1', source: 'weldconnect' });
    expect(published).toEqual([
      expect.objectContaining({ entityType: 'person', action: 'created', userId: 'member_1', workflowDepth: 1 }),
    ]);
  });

  it('reuses a contact with the same email instead of duplicating it', async () => {
    const res = await app()('/create-contact', { ...actor('member_1'), contact: { email: 'ADA@example.test' } });
    const body = (await res.json()) as { created: boolean };
    expect(body.created).toBe(false);
    expect(published).toEqual([]);
  });

  it('refuses when the owner may not create contacts', async () => {
    const res = await app()('/create-contact', { ...actor('viewer_1'), contact: { firstName: 'No' } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/permission to create contacts/);
  });

  it('refuses when the owner left the workspace', async () => {
    const res = await app()('/create-contact', { ...actor('gone_1'), contact: { firstName: 'No' } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/no longer a member/);
  });

  it('rejects an invalid email before touching the database', async () => {
    const res = await app()('/create-contact', { ...actor('member_1'), contact: { email: 'not-an-email' } });
    expect(res.status).toBe(400);
  });
});

describe('POST /update-contact', () => {
  let ownContactId: string;
  let otherContactId: string;

  beforeAll(async () => {
    const own = await app()('/create-contact', { ...actor('member_1'), contact: { firstName: 'Own', email: 'own@example.test' } });
    ownContactId = ((await own.json()) as { contact: { id: string } }).contact.id;
    const other = await app()('/create-contact', { ...actor('member_2'), contact: { firstName: 'Other', email: 'other@example.test' } });
    otherContactId = ((await other.json()) as { contact: { id: string } }).contact.id;
  });

  it('updates only the fields given and publishes person:updated', async () => {
    const res = await app()('/update-contact', { ...actor('member_1'), contactId: ownContactId, contact: { title: 'CTO' } });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(schema.people).where(eq(schema.people.id, ownContactId));
    expect(row).toMatchObject({ firstName: 'Own', title: 'CTO' });
    expect(published).toEqual([expect.objectContaining({ entityType: 'person', action: 'updated', workflowDepth: 1 })]);
  });

  it("keeps a member's workflow to contacts they own", async () => {
    const res = await app()('/update-contact', { ...actor('member_1'), contactId: otherContactId, contact: { title: 'X' } });
    expect(res.status).toBe(404);
  });

  it('lets an owner with people:scope:all update any contact', async () => {
    const res = await app()('/update-contact', { ...actor('admin_1'), contactId: otherContactId, contact: { title: 'Lead' } });
    expect(res.status).toBe(200);
  });
});
