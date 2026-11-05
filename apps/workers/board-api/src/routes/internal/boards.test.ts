import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit';
import { schema } from '@weldsuite/worker-kit/db';
import type { BoardSnapshot } from '@weldsuite/board-engine';
import type { Env, Variables } from '../../types';
import { FakeBucket, liveRoomNamespace } from '../../test-support/fakes';
import internalRoutes from './boards';

let db: Database;
let readOnly = false;
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getTenantDbForWorkspace: async () => db,
  getWorkspaceContextForOrg: async (_env: unknown, ref: string) => ({
    id: 'ws_test_default',
    clerkOrgId: ref,
    db,
    suspended: false,
    licensedApps: null,
    readOnly,
    readOnlyReason: readOnly ? ('licence_inactive' as const) : null,
  }),
}));

const WORKSPACE = 'org_test_default';
const ALICE = 'user_alice';
const BOB = 'user_bob';

let bucket: FakeBucket;
let rooms: ReturnType<typeof liveRoomNamespace>;

const env = () => ({ PRIVATE_STORAGE: bucket.asBinding(), BOARD_ROOM: rooms.binding }) as unknown as Env;

function call(path: string, body: unknown = {}, userId = ALICE) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.route('/internal/boards', internalRoutes);
  return app.request(`/internal/boards/${WORKSPACE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-weld-user': userId }, body: JSON.stringify(body) }, env());
}

async function data<T>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const r = await res;
  expect(r.status).toBe(status);
  return ((await r.json()) as { data: T }).data;
}

async function member(userId: string, role = 'MEMBER') {
  await db.insert(schema.workspaceMembers).values({ id: `wm_${userId}`, userId, name: userId, role } as typeof schema.workspaceMembers.$inferInsert);
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await db.delete(schema.boardVersions);
  await db.delete(schema.whiteboards);
  await db.delete(schema.projectWhiteboards);
  await db.delete(schema.files);
  await db.delete(schema.projectMembers);
  await db.delete(schema.projects);
  await db.delete(schema.workspaceMembers);
  bucket = new FakeBucket();
  rooms = liveRoomNamespace(env);
  readOnly = false;
  const now = new Date();
  await db.insert(schema.projects).values({ id: 'prj_a', name: 'Apollo', status: 'active', createdAt: now, updatedAt: now });
  await db.insert(schema.projectMembers).values({ id: 'pm_a', projectId: 'prj_a', userId: ALICE, role: 'member', createdAt: now, updatedAt: now });
  await member(ALICE, 'MEMBER');
  await member(BOB, 'MEMBER');
});

type Brief = { id: string; name: string; projectId: string | null; legacy: boolean; role: string; url: string };
type LegacyRow = { id: string; name: string; projectId: string; elements: { id: string; type: string; text?: string }[] };

describe('internal board routes', () => {
  it('serve the WeldFlow whiteboard format on top of boards', async () => {
    const created = await data<Brief & { row: LegacyRow }>(
      call('/create', { name: 'Sprint plan', projectId: 'prj_a', elements: [{ id: 'n1', type: 'sticky', x: 0, y: 0, width: 200, height: 200, text: 'Plan' }] }),
      201,
    );
    expect(created).toMatchObject({ name: 'Sprint plan', projectId: 'prj_a', url: `/weldflow/project/prj_a/whiteboard/${created.id}` });
    expect(created.row.elements.map((e) => [e.id, e.text])).toEqual([['n1', 'Plan']]);

    const found = await data<{ boards: Brief[]; total: number }>(call('/find', { projectId: 'prj_a' }));
    expect(found.boards.map((b) => b.name)).toEqual(['Sprint plan']);

    const updated = await data<{ row: LegacyRow }>(
      call(`/${created.id}/update`, {
        name: 'Sprint 12 plan',
        elements: [
          { id: 'n1', type: 'sticky', x: 0, y: 0, width: 200, height: 200, text: 'Plan, revised' },
          { id: 'n2', type: 'sticky', x: 300, y: 0, width: 200, height: 200, text: 'Risks' },
        ],
      }),
    );
    expect(updated.row.name).toBe('Sprint 12 plan');
    expect(updated.row.elements.map((e) => e.text).sort()).toEqual(['Plan, revised', 'Risks']);

    const read = await data<{ row: LegacyRow }>(call(`/${created.id}/read`, { format: 'legacy' }));
    expect(read.row.elements).toHaveLength(2);
    expect(await data<{ text: string }>(call(`/${created.id}/read`, { format: 'text' }))).toMatchObject({ text: expect.stringContaining('Risks') });
    const outline = await data<{ elements: { id: string }[]; count: number }>(call(`/${created.id}/read`, { format: 'outline' }));
    expect(outline.count).toBe(2);

    // Not a project member: the board is not there for them.
    expect((await call(`/${created.id}/read`, { format: 'legacy' }, BOB)).status).toBe(404);
    expect((await call('/find', { projectId: 'prj_a' }, BOB)).status).toBe(404);
  });

  it('reads an old WeldFlow whiteboard as it is and converts it only to write', async () => {
    const now = new Date();
    await db.insert(schema.projectWhiteboards).values({
      id: 'pwb_1',
      projectId: 'prj_a',
      name: 'Legacy',
      elements: [{ id: 'n1', type: 'sticky', x: 0, y: 0, width: 200, height: 200, text: 'Old' }],
      createdAt: now,
      updatedAt: now,
    });
    const read = await data<Brief & { row: LegacyRow }>(call('/pwb_1/read', { format: 'legacy' }));
    expect(read).toMatchObject({ legacy: true, row: { id: 'pwb_1', elements: [{ id: 'n1', text: 'Old' }] } });
    expect(await db.select().from(schema.whiteboards)).toHaveLength(0);

    const op = { type: 'set', id: 'n1', patch: { fill: '#bbf7d0' } };
    expect(await data<{ revision: number }>(call('/pwb_1/apply', { op }))).toMatchObject({ revision: 1 });
    const [board] = await db.select().from(schema.whiteboards).where(eq(schema.whiteboards.id, 'pwb_1'));
    expect(board).toBeTruthy();
    const snap = await data<{ snapshot: BoardSnapshot }>(call('/pwb_1/read', { format: 'snapshot' }));
    expect(snap.snapshot.elements[0]).toMatchObject({ id: 'n1', fill: '#bbf7d0' });
    expect((await call('/pwb_1/apply', { op: { type: 'explode' } })).status).toBe(400);
  });

  it('lets a workspace API key reach every project board, and nothing private', async () => {
    const asKey = (path: string, body: unknown = {}) => {
      const app = new Hono<{ Bindings: Env; Variables: Variables }>();
      app.route('/internal/boards', internalRoutes);
      return app.request(`/internal/boards/${WORKSPACE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-weld-workspace-key': 'wak_1' }, body: JSON.stringify(body) }, env());
    };
    // A project ALICE is on but the key's actor is not: the key still reaches it.
    const created = await data<Brief & { row: LegacyRow }>(asKey('/create', { name: 'From the API', projectId: 'prj_a', elements: [] }), 201);
    expect(created.projectId).toBe('prj_a');
    const found = await data<{ boards: Brief[] }>(asKey('/find', { projects: true }));
    expect(found.boards.map((b) => b.name)).toEqual(['From the API']);
    expect(await data<{ row: LegacyRow }>(asKey(`/${created.id}/update`, { name: 'Renamed by the API' }))).toMatchObject({ row: { name: 'Renamed by the API' } });

    // ALICE's own board in her drive, shared with nobody: not the key's.
    const mine = await data<Brief>(call('/create', { name: 'Private' }), 201);
    await db.update(schema.files).set({ generalAccess: 'restricted' }).where(eq(schema.files.fileName, 'Private'));
    expect((await asKey(`/${mine.id}/read`)).status).toBe(404);
  });

  it('deletes, and refuses writes in a read-only workspace', async () => {
    const created = await data<Brief>(call('/create', { name: 'Scratch' }), 201);
    readOnly = true;
    expect((await call(`/${created.id}/update`, { name: 'Nope' })).status).toBe(403);
    readOnly = false;
    expect((await call(`/${created.id}/delete`)).status).toBe(204);
    expect((await call(`/${created.id}/read`)).status).toBe(404);
    expect((await call('/brd_x/read', {}, '')).status).toBe(401);
  });
});
