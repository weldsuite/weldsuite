/**
 * A task created from a WeldDesk ticket (WeldSuite task 1223): both creates
 * store `sourceType` + `sourceId`, every task response carries them, and the
 * list filters on them so the ticket's details panel can show its tasks.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { tasksRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>(
    '@weldsuite/entity-events',
  );
  // A spy that still publishes: conformance mode compares the events.
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  const now = new Date();
  await db
    .insert(schema.projects)
    .values({ id: 'proj_src', name: 'Support follow-ups', createdAt: now, updatedAt: now } as typeof schema.projects.$inferInsert);
}, 60_000);

const json = { 'Content-Type': 'application/json' };
const TICKET = 'dconv_src_ticket';
const OTHER_TICKET = 'dconv_src_other';

type TaskBody = { id: string; title: string; sourceType: string | null; sourceId: string | null };

const app = () =>
  createTestApp('/api/tasks', tasksRoutes, {
    context: {
      permissions: permissions('tasks:read', 'tasks:create', 'tasks:update', 'projects:scope:all'),
      tenantDb: db,
    },
  });
const send = (method: string, path: string, body?: unknown) =>
  app().request(`/api/tasks${path}`, {
    method,
    headers: json,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function create(path: string, body: Record<string, unknown>): Promise<TaskBody> {
  const res = await send('POST', path, body);
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: TaskBody }).data;
}

async function listIds(query: string): Promise<string[]> {
  const res = await send('GET', `?${query}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: TaskBody[] }).data.map((task) => task.id);
}

describe('/api/tasks · created from a ticket · pglite integration', () => {
  it('POST / stores the source and answers it', async () => {
    const created = await create('', {
      title: '#42 Refund not received',
      sourceType: 'desk_conversation',
      sourceId: TICKET,
    });
    expect(created.sourceType).toBe('desk_conversation');
    expect(created.sourceId).toBe(TICKET);

    const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, created.id)).limit(1);
    expect(row?.sourceType).toBe('desk_conversation');
    expect(row?.sourceId).toBe(TICKET);

    const detail = await send('GET', `/${created.id}`);
    const body = ((await detail.json()) as { data: TaskBody }).data;
    expect(body.sourceType).toBe('desk_conversation');
    expect(body.sourceId).toBe(TICKET);
  });

  it('POST /projects/:projectId stores the source too', async () => {
    const created = await create('/projects/proj_src', {
      title: '#42 Check the payment provider',
      sourceType: 'desk_conversation',
      sourceId: TICKET,
    });
    expect(created.sourceType).toBe('desk_conversation');
    expect(created.sourceId).toBe(TICKET);
  });

  it('a task created without one has no source', async () => {
    const created = await create('', { title: 'Plain task' });
    expect(created.sourceType).toBeNull();
    expect(created.sourceId).toBeNull();
  });

  it('GET /?sourceType&sourceId lists only the tasks of that ticket, project or not', async () => {
    const mine = await create('', { title: 'From the ticket', sourceType: 'desk_conversation', sourceId: TICKET });
    const other = await create('', {
      title: 'From another ticket',
      sourceType: 'desk_conversation',
      sourceId: OTHER_TICKET,
    });
    const plain = await create('', { title: 'Not from a ticket' });

    const ids = await listIds(`sourceType=desk_conversation&sourceId=${TICKET}&limit=200`);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(other.id);
    expect(ids).not.toContain(plain.id);
    // Both creates above, the project one included.
    expect(ids).toHaveLength(3);

    const bySourceType = await listIds('sourceType=desk_conversation&limit=200');
    expect(bySourceType).toContain(other.id);
    expect(bySourceType).not.toContain(plain.id);
  });

  it('refuses a source type it does not know with 400', async () => {
    const res = await send('POST', '', { title: 'x', sourceType: 'crm_deal', sourceId: 'deal_1' });
    expect(res.status).toBe(400);
    expect((await send('GET', '?sourceType=crm_deal')).status).toBe(400);
  });

  it('refuses a source id longer than the column with 400', async () => {
    const res = await send('POST', '', { title: 'x', sourceType: 'desk_conversation', sourceId: 'd'.repeat(31) });
    expect(res.status).toBe(400);
  });

  it('PATCH leaves the source alone', async () => {
    const created = await create('', { title: 'Keep my ticket', sourceType: 'desk_conversation', sourceId: TICKET });
    const res = await send('PATCH', `/${created.id}`, { title: 'Renamed', sourceId: OTHER_TICKET });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, created.id)).limit(1);
    expect(row?.title).toBe('Renamed');
    expect(row?.sourceId).toBe(TICKET);
  });
});
