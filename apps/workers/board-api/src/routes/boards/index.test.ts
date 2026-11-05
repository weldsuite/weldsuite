import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit';
import { boardVersions, files, folders, projectMembers, projectWhiteboards, projects, whiteboards, workspaceMembers } from '@weldsuite/db/schema';
import { WELDBOARD_MIME_TYPE, type BoardSession, type BoardSummary, type BoardVersion } from '@weldsuite/app-api-client/schemas/boards';
import { emptySnapshot, makeSticky, type BoardElement, type BoardSnapshot } from '@weldsuite/board-engine';
import type { Env, Variables } from '../../types';
import { readSnapshot } from '../../room/snapshot';
import { FakeBucket, fakeRoomNamespace, liveRoomNamespace } from '../../test-support/fakes';
import boardRoutes from './index';

let db: Database;
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getTenantDbForWorkspace: async () => db,
}));

const ALL = ['boards:read', 'boards:create', 'boards:update', 'boards:delete', 'boards:comment'];
const ALICE = 'user_alice';
const BOB = 'user_bob';
const ORG = 'org_test_default';

let bucket: FakeBucket;
let live: ReturnType<typeof liveRoomNamespace>;
let sessions: ReturnType<typeof fakeRoomNamespace>;
let useLiveRooms = true;

function env(): Env {
  return { PRIVATE_STORAGE: bucket.asBinding(), BOARD_ROOM: useLiveRooms ? live.binding : sessions.binding } as unknown as Env;
}

function app(options: { userId?: string; keys?: string[] } = {}) {
  return createTestApp<Env, Variables>('/api/boards', boardRoutes, {
    context: { tenantDb: db, permissions: permissions(...(options.keys ?? ALL)), userId: options.userId ?? ALICE },
    env: env() as unknown as Record<string, unknown>,
  });
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function create(body: Record<string, unknown>, userId = ALICE): Promise<BoardSummary> {
  const res = await app({ userId }).request('/api/boards', json('POST', body));
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: BoardSummary }).data;
}

async function listOf(query = '', userId = ALICE): Promise<BoardSummary[]> {
  const res = await app({ userId }).request(`/api/boards${query}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: BoardSummary[] }).data;
}

const withSticky = (text: string): BoardSnapshot => ({ ...emptySnapshot(), elements: [makeSticky(0, 0, {}, { id: 'st1', text })] });

async function snapshotOf(id: string, userId = ALICE): Promise<BoardSnapshot> {
  const res = await app({ userId }).request(`/api/boards/${id}/snapshot`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { snapshot: BoardSnapshot } }).data.snapshot;
}

async function seedProject(id: string, members: Record<string, string>): Promise<void> {
  const now = new Date();
  await db.insert(projects).values({ id, name: `Project ${id}`, status: 'active', createdAt: now, updatedAt: now });
  for (const [userId, role] of Object.entries(members)) {
    await db.insert(projectMembers).values({ id: `pm_${id}_${userId}`, projectId: id, userId, role, createdAt: now, updatedAt: now });
  }
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await db.delete(boardVersions);
  await db.delete(whiteboards);
  await db.delete(projectWhiteboards);
  await db.delete(files);
  await db.delete(folders);
  await db.delete(projectMembers);
  await db.delete(projects);
  await db.delete(workspaceMembers);
  bucket = new FakeBucket();
  live = liveRoomNamespace(env);
  sessions = fakeRoomNamespace();
  useLiveRooms = true;
});

describe('/api/boards', () => {
  it('creates a board as a drive file with a first checkpoint', async () => {
    const board = await create({ name: 'Retro' });
    expect(board).toMatchObject({ name: 'Retro', role: 'owner', canEdit: true, folderId: null, projectId: null, legacy: false, templateCategory: null });
    expect(board.id).toMatch(/^brd_/);
    const [file] = await db.select().from(files).where(eq(files.id, board.fileId!));
    expect(file).toMatchObject({ mimeType: WELDBOARD_MIME_TYPE, fileType: 'whiteboard', uploadedById: ALICE, bucket: 'private', entityType: null });
    expect(file!.metadata).toEqual({ weldBoardId: board.id });
    const stored = await readSnapshot(bucket.asBinding(), `workspaces/${ORG}/boards/${board.id}/board.json.gz`);
    expect(stored).toEqual({ revision: 0, board: emptySnapshot() });
  });

  it('starts from a snapshot, refuses one that is not, and copies another board without its comments', async () => {
    const from = await create({ name: 'Source', snapshot: withSticky('Keep me') });
    expect((await snapshotOf(from.id)).elements.map((e) => e.id)).toEqual(['st1']);
    expect((await app().request('/api/boards', json('POST', { snapshot: { version: 1, elements: 'no' } }))).status).toBe(400);

    // A comment pin on the source stays with the source.
    const pin: BoardElement = { id: 'c1', type: 'comment', order: 'a9', x: 0, y: 0, w: 32, h: 32, createdBy: ALICE, thread: 't1' };
    const name = `${ORG}:${from.id}`;
    await live.roomFor(name).room.applyOps({ workspaceId: ORG, boardId: from.id, snapshotKey: `workspaces/${ORG}/boards/${from.id}/board.json.gz` }, { type: 'create', elements: [pin] }, ALICE);
    const copy = await create({ fromBoardId: from.id });
    // The drive keeps names unique in a folder.
    expect(copy.name).toBe('Source (1)');
    expect((await snapshotOf(copy.id)).elements.map((e) => e.id)).toEqual(['st1']);
  });

  it('lists, searches, renames and pages', async () => {
    const a = await create({ name: 'Roadmap' });
    await create({ name: 'Retro' });
    await create({ name: 'Kickoff' });
    expect((await listOf()).map((b) => b.name).sort()).toEqual(['Kickoff', 'Retro', 'Roadmap']);
    expect((await listOf('?search=ro')).map((b) => b.name).sort()).toEqual(['Retro', 'Roadmap']);
    const page = (await (await app().request('/api/boards?limit=2')).json()) as { data: BoardSummary[]; pagination: { hasMore: boolean; cursor: string } };
    expect(page.data).toHaveLength(2);
    expect(page.pagination).toMatchObject({ hasMore: true, cursor: '2' });

    const res = await app().request(`/api/boards/${a.id}`, json('PATCH', { name: 'Roadmap 2027' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: BoardSummary }).data.name).toBe('Roadmap 2027');
    expect((await app().request(`/api/boards/${a.id}`, json('PATCH', { name: 'Retro' }))).status).toBe(409);
    expect((await app().request('/api/boards/brd_nope')).status).toBe(404);
  });

  it('follows drive sharing: hidden boards are 404, view-only ones cannot change', async () => {
    const hidden = await create({ name: 'Private' });
    await db.update(files).set({ generalAccess: 'restricted' }).where(eq(files.id, hidden.fileId!));
    const shown = await create({ name: 'Read me' });
    await db.update(files).set({ generalAccess: 'workspace_view' }).where(eq(files.id, shown.fileId!));
    const bob = app({ userId: BOB });
    expect((await bob.request(`/api/boards/${hidden.id}`)).status).toBe(404);
    const list = await listOf('', BOB);
    expect(list.map((b) => b.name)).toEqual(['Read me']);
    expect(list[0]).toMatchObject({ role: 'viewer', canEdit: false });
    expect((await bob.request(`/api/boards/${shown.id}`, json('PATCH', { name: 'Mine now' }))).status).toBe(403);
    expect((await bob.request(`/api/boards/${shown.id}`, { method: 'DELETE' })).status).toBe(403);
  });

  it('only creates in folders the caller may add to', async () => {
    await db.insert(folders).values({ id: 'fld_closed', name: 'Closed', createdById: BOB, generalAccess: 'workspace_view' });
    expect((await app().request('/api/boards', json('POST', { name: 'Nope', folderId: 'fld_closed' }))).status).toBe(403);
    expect((await app().request('/api/boards', json('POST', { name: 'Nope', folderId: 'fld_missing' }))).status).toBe(404);
  });

  it('makes templates everyone can see and start from', async () => {
    const tpl = await create({ name: 'Our retro', snapshot: withSticky('Went well'), template: { category: 'meetings' } });
    expect(tpl.templateCategory).toBe('meetings');
    await db.update(files).set({ generalAccess: 'restricted' }).where(eq(files.id, tpl.fileId!));
    const bobs = await listOf('?templates=true', BOB);
    expect(bobs.map((b) => [b.name, b.role])).toEqual([['Our retro', 'viewer']]);
    const fromTemplate = await create({ fromBoardId: tpl.id, name: 'Sprint 12 retro' }, BOB);
    expect((await snapshotOf(fromTemplate.id, BOB)).elements).toHaveLength(1);

    const plain = await create({ name: 'Plain' });
    const res = await app().request(`/api/boards/${plain.id}`, json('PATCH', { template: { category: 'ideation' } }));
    expect(((await res.json()) as { data: BoardSummary }).data.templateCategory).toBe('ideation');
    expect((await listOf('?templates=true')).map((b) => b.name).sort()).toEqual(['Our retro', 'Plain']);
  });

  it('moves a board to the trash', async () => {
    const board = await create({ name: 'Old' });
    expect((await app().request(`/api/boards/${board.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await app().request(`/api/boards/${board.id}`)).status).toBe(404);
    const [file] = await db.select().from(files).where(eq(files.id, board.fileId!));
    expect(file!.deletedAt).not.toBeNull();
  });

  it('opens a session with the member profile, as edit, comment or view', async () => {
    useLiveRooms = false;
    await db.insert(workspaceMembers).values({ id: 'wm_alice', userId: ALICE, name: 'Alice Jansen', picture: 'https://img/alice.png' });
    const board = await create({ name: 'Shared' });
    await db.update(files).set({ generalAccess: 'workspace_view' }).where(eq(files.id, board.fileId!));
    const res = await app().request(`/api/boards/${board.id}/session`, { method: 'POST' });
    const session = ((await res.json()) as { data: BoardSession }).data;
    expect(session).toMatchObject({ canEdit: true, mode: 'edit', ticket: `${'f'.repeat(64)}.ticket-for-${ALICE}` });
    expect(sessions.admissions.at(-1)).toMatchObject({ name: `${ORG}:${board.id}`, admission: { boardId: board.id, name: 'Alice Jansen', canEdit: true } });

    const commenter = ((await (await app({ userId: BOB }).request(`/api/boards/${board.id}/session`, { method: 'POST' })).json()) as { data: BoardSession }).data;
    expect(commenter).toMatchObject({ canEdit: false, mode: 'comment' });
    const viewer = await app({ userId: BOB, keys: ['boards:read'] }).request(`/api/boards/${board.id}/session`, { method: 'POST' });
    expect(((await viewer.json()) as { data: BoardSession }).data.mode).toBe('view');
  });

  it('imports Excalidraw scenes and text, and refuses what it cannot read', async () => {
    const scene = JSON.stringify({
      type: 'excalidraw',
      elements: [
        { id: 'r1', type: 'rectangle', x: 0, y: 0, width: 100, height: 60, strokeColor: '#1e1e1e', backgroundColor: 'transparent' },
        { id: 'img', type: 'image', x: 0, y: 0, width: 10, height: 10 },
      ],
    });
    const res = await app().request('/api/boards/import', json('POST', { name: 'Imported', format: 'excalidraw', content: scene }));
    expect(res.status).toBe(201);
    const imported = ((await res.json()) as { data: BoardSummary & { skipped: number } }).data;
    expect(imported.skipped).toBe(1);
    expect((await snapshotOf(imported.id)).elements.map((e) => e.type)).toEqual(['shape']);

    const text = await app().request('/api/boards/import', json('POST', { name: 'Ideas', format: 'text', content: 'One\nTwo\nThree' }));
    const ideas = ((await text.json()) as { data: BoardSummary }).data;
    expect((await snapshotOf(ideas.id)).elements.filter((e) => e.type === 'sticky')).toHaveLength(3);
    expect((await app().request('/api/boards/import', json('POST', { name: 'Bad', format: 'excalidraw', content: '{nope' }))).status).toBe(400);
  });
});

describe('WeldFlow project boards', () => {
  beforeEach(async () => {
    await seedProject('prj_a', { [ALICE]: 'member', [BOB]: 'viewer' });
  });

  it('creates project boards that follow the project, not the drive', async () => {
    const board = await create({ name: 'Architecture', projectId: 'prj_a' });
    expect(board.projectId).toBe('prj_a');
    const [file] = await db.select().from(files).where(eq(files.id, board.fileId!));
    expect(file).toMatchObject({ entityType: 'project', entityId: 'prj_a', folderId: null });

    // Project boards are not in the drive list; they are in the project's.
    expect((await listOf()).map((b) => b.name)).toEqual([]);
    expect((await listOf('?projectId=prj_a')).map((b) => b.name)).toEqual(['Architecture']);
    // A project viewer sees it read-only; an outsider not at all.
    const bobs = await listOf('?projectId=prj_a', BOB);
    expect(bobs[0]).toMatchObject({ role: 'viewer', canEdit: false });
    expect((await app({ userId: 'user_eve' }).request(`/api/boards/${board.id}`)).status).toBe(404);
    expect((await app({ userId: 'user_eve' }).request('/api/boards?projectId=prj_a')).status).toBe(404);
    // Only those who may change the project's work add boards to it.
    expect((await app({ userId: BOB }).request('/api/boards', json('POST', { name: 'Nope', projectId: 'prj_a' }))).status).toBe(403);
    expect((await app().request(`/api/boards/${board.id}`, json('PATCH', { template: { category: 'other' } }))).status).toBe(400);
  });

  it('lists old WeldFlow whiteboards with the project boards and converts one in place on open', async () => {
    const elements = [{ id: 'n1', type: 'sticky', x: 10, y: 20, width: 200, height: 200, text: 'From WeldFlow', color: '#fef08a' }];
    await db.insert(projectWhiteboards).values({ id: 'pwb_old', projectId: 'prj_a', name: 'Old board', elements, lastEditedBy: BOB, createdAt: new Date(Date.now() - 120_000), updatedAt: new Date(Date.now() - 60_000) });
    await create({ name: 'New board', projectId: 'prj_a' });

    const listed = await listOf('?projectId=prj_a');
    expect(listed.map((b) => [b.name, b.legacy])).toEqual([
      ['New board', false],
      ['Old board', true],
    ]);
    expect((await listOf('?projects=true')).map((b) => b.name).sort()).toEqual(['New board', 'Old board']);
    const old = ((await (await app().request('/api/boards/pwb_old')).json()) as { data: BoardSummary }).data;
    expect(old).toMatchObject({ legacy: true, fileId: null, projectId: 'prj_a', role: 'editor' });

    const res = await app().request('/api/boards/convert', json('POST', { whiteboardId: 'pwb_old' }));
    expect(res.status).toBe(201);
    const converted = ((await res.json()) as { data: BoardSummary }).data;
    expect(converted).toMatchObject({ id: 'pwb_old', name: 'Old board', legacy: false, projectId: 'prj_a' });
    const content = await snapshotOf('pwb_old');
    expect(content.elements.map((e) => e.type)).toEqual(['sticky']);
    const [row] = await db.select().from(projectWhiteboards).where(eq(projectWhiteboards.id, 'pwb_old'));
    expect(row!.deletedAt).not.toBeNull();

    // Converting again (a second tab, a second person) returns the same board.
    const again = await app({ userId: BOB }).request('/api/boards/convert', json('POST', { whiteboardId: 'pwb_old' }));
    expect(again.status).toBe(200);
    expect(((await again.json()) as { data: BoardSummary }).data).toMatchObject({ id: 'pwb_old', role: 'viewer' });
    expect((await listOf('?projectId=prj_a')).map((b) => b.legacy)).toEqual([false, false]);
  });

  it('keeps a checkpoint written by the board that won a convert race', async () => {
    await db.insert(projectWhiteboards).values({ id: 'pwb_race', projectId: 'prj_a', name: 'Race', elements: [], createdAt: new Date(), updatedAt: new Date() });
    const key = `workspaces/${ORG}/boards/pwb_race/board.json.gz`;
    // The winner's room already checkpointed an edit at the key.
    await bucket.put(key, 'not a snapshot the loser may overwrite');
    await app().request('/api/boards/convert', json('POST', { whiteboardId: 'pwb_race' }));
    expect(new TextDecoder().decode(bucket.objects.get(key))).toBe('not a snapshot the loser may overwrite');
  });

  it('deletes an old whiteboard nobody opened, as WeldFlow did', async () => {
    await db.insert(projectWhiteboards).values({ id: 'pwb_gone', projectId: 'prj_a', name: 'Gone', elements: [], createdAt: new Date(), updatedAt: new Date() });
    expect((await app({ userId: BOB }).request('/api/boards/pwb_gone', { method: 'DELETE' })).status).toBe(403);
    expect((await app().request('/api/boards/pwb_gone', { method: 'DELETE' })).status).toBe(204);
    expect((await app().request('/api/boards/pwb_gone')).status).toBe(404);
  });
});

describe('/api/boards/:id/versions', () => {
  it('saves, renames, reads and restores versions', async () => {
    const board = await create({ name: 'Versioned', snapshot: withSticky('v1') });
    const saved = await app().request(`/api/boards/${board.id}/versions`, json('POST', { name: 'Before the workshop' }));
    expect(saved.status).toBe(201);
    const version = ((await saved.json()) as { data: BoardVersion }).data;
    expect(version).toMatchObject({ boardId: board.id, name: 'Before the workshop', revision: 0 });

    const meta = { workspaceId: ORG, boardId: board.id, snapshotKey: `workspaces/${ORG}/boards/${board.id}/board.json.gz` };
    await live.roomFor(`${ORG}:${board.id}`).room.applyOps(meta, { type: 'delete', ids: ['st1'] }, ALICE);
    expect((await snapshotOf(board.id)).elements).toEqual([]);

    const renamed = await app().request(`/api/boards/${board.id}/versions/${version.id}`, json('PATCH', { name: 'Workshop start' }));
    expect(((await renamed.json()) as { data: BoardVersion }).data.name).toBe('Workshop start');
    const stored = await app().request(`/api/boards/${board.id}/versions/${version.id}/snapshot`);
    expect(((await stored.json()) as { data: { snapshot: BoardSnapshot } }).data.snapshot.elements).toHaveLength(1);

    const restored = await app().request(`/api/boards/${board.id}/versions/${version.id}/restore`, json('POST', {}));
    expect(restored.status).toBe(200);
    const result = ((await restored.json()) as { data: { revision: number; autoVersion: BoardVersion } }).data;
    expect(result.autoVersion).toMatchObject({ name: null, revision: 1 });
    expect((await snapshotOf(board.id)).elements.map((e) => e.id)).toEqual(['st1']);
    const list = (await (await app().request(`/api/boards/${board.id}/versions`)).json()) as { data: BoardVersion[] };
    expect(list.data).toHaveLength(2);

    // A viewer may read the history but not save or restore.
    await db.update(files).set({ generalAccess: 'workspace_view' }).where(eq(files.id, board.fileId!));
    expect((await app({ userId: BOB }).request(`/api/boards/${board.id}/versions`)).status).toBe(200);
    expect((await app({ userId: BOB }).request(`/api/boards/${board.id}/versions`, json('POST', { name: 'Mine' }))).status).toBe(403);
  });
});
