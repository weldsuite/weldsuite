import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/db/testing/pglite';
import * as schema from '@weldsuite/db/schema';
import type { TenantDb as Database } from '@weldsuite/db/lib/any-db';
import {
  BOARD_FILE_TYPE,
  PROJECT_ENTITY,
  convertLegacy,
  createBoard,
  getBoard,
  getLiveBoard,
  isLive,
  legacyElements,
  listBoards,
  projectExists,
  recordCheckpoint,
  snapshotKeyFor,
  trashBoard,
  trashLegacy,
  updateBoard,
  type BoardRecord,
  type LiveBoardRecord,
} from './boards';

const { files, whiteboards, projectWhiteboards, projects } = schema;
const WORKSPACE = 'org_boards_test';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await db.delete(whiteboards);
  await db.delete(files);
  await db.delete(projectWhiteboards);
  await db.delete(projects);
});

const board = (boardId: string, name: string, extra: Partial<Parameters<typeof createBoard>[1]> = {}) =>
  createBoard(db, { workspaceId: WORKSPACE, boardId, name, folderId: null, userId: 'alice', snapshotSize: 10, ...extra });

async function project(id: string, deleted = false): Promise<void> {
  const now = new Date();
  await db.insert(projects).values({ id, name: id, createdAt: now, updatedAt: now, ...(deleted ? { deletedAt: now } : {}) } as typeof projects.$inferInsert);
}

/** An old WeldFlow whiteboard, last changed `minutesAgo`. */
async function legacy(id: string, projectId: string, name: string, minutesAgo: number, elements: unknown = [{ type: 'rectangle' }]): Promise<void> {
  const at = new Date(Date.now() - minutesAgo * 60_000);
  await db.insert(projectWhiteboards).values({ id, projectId, name, elements: elements as unknown[], createdAt: at, updatedAt: at, lastEditedBy: 'bob' });
}

/** Sets when a board last changed, both rows. */
async function touch(id: string, minutesAgo: number): Promise<void> {
  const at = new Date(Date.now() - minutesAgo * 60_000);
  const [row] = await db.update(whiteboards).set({ updatedAt: at }).where(eq(whiteboards.id, id)).returning({ fileId: whiteboards.fileId });
  await db.update(files).set({ updatedAt: at }).where(eq(files.id, row!.fileId));
}

const ids = (rows: BoardRecord[]) => rows.map((r) => r.id);

describe('creating and reading boards', () => {
  it('pairs a drive file with the board row', async () => {
    const created = await board('brd_1', 'Roadmap');
    expect(created).toMatchObject({
      id: 'brd_1',
      name: 'Roadmap',
      folderId: null,
      createdById: 'alice',
      updatedById: 'alice',
      revision: 0,
      snapshotKey: snapshotKeyFor(WORKSPACE, 'brd_1'),
      projectId: null,
      templateCategory: null,
      legacy: false,
      file: { id: created.fileId, uploadedById: 'alice', folderId: null, entityType: null },
    });
    expect(isLive(created)).toBe(true);
    const [file] = await db.select().from(files).where(eq(files.id, created.fileId));
    expect(file).toMatchObject({ fileType: BOARD_FILE_TYPE, fileKey: created.snapshotKey, metadata: { weldBoardId: 'brd_1' } });
    expect(await getBoard(db, 'brd_missing')).toBeNull();
  });

  it('files a project’s board under the project, never in a folder', async () => {
    await project('prj_1');
    const created = await board('brd_p', 'Sprint', { projectId: 'prj_1', folderId: 'fld_ignored' });
    expect(created).toMatchObject({ projectId: 'prj_1', folderId: null, file: { entityType: PROJECT_ENTITY } });
  });

  it('marks templates with their category', async () => {
    expect((await board('brd_t', 'Retro template', { templateCategory: 'meetings' })).templateCategory).toBe('meetings');
  });
});

describe('listBoards', () => {
  beforeEach(async () => {
    await project('prj_1');
    await project('prj_2');
    await project('prj_gone', true);
    await board('brd_drive', 'Roadmap');
    await board('brd_tpl', '50%_off template', { templateCategory: 'ideation' });
    await board('brd_p1', 'Sprint board', { projectId: 'prj_1' });
    await board('brd_p2', 'Other sprint', { projectId: 'prj_2' });
    await board('brd_gone', 'Gone project board', { projectId: 'prj_gone' });
    await touch('brd_drive', 30);
    await touch('brd_tpl', 20);
    await touch('brd_p1', 10);
    await touch('brd_p2', 5);
    await legacy('wb_old', 'prj_1', 'Old sprint', 15);
    await legacy('wb_older', 'prj_1', 'Older sprint', 40);
  });

  it('lists the boards in no project, newest first, a page at a time', async () => {
    const all = await listBoards(db, { scope: { kind: 'drive' }, limit: 10, offset: 0 });
    expect(ids(all.rows)).toEqual(['brd_tpl', 'brd_drive']);
    expect(all.total).toBe(2);
    const second = await listBoards(db, { scope: { kind: 'drive' }, limit: 1, offset: 1 });
    expect(ids(second.rows)).toEqual(['brd_drive']);
    expect(second.total).toBe(2);
  });

  it('lists templates, and finds names with LIKE wildcards in them literally', async () => {
    expect(ids((await listBoards(db, { scope: { kind: 'templates' }, limit: 10, offset: 0 })).rows)).toEqual(['brd_tpl']);
    expect(ids((await listBoards(db, { scope: { kind: 'drive' }, search: '50%_', limit: 10, offset: 0 })).rows)).toEqual(['brd_tpl']);
    expect(ids((await listBoards(db, { scope: { kind: 'drive' }, search: '%', limit: 10, offset: 0 })).rows)).toEqual(['brd_tpl']);
  });

  it('merges a project’s boards with its old whiteboards by last change', async () => {
    const listed = await listBoards(db, { scope: { kind: 'project', projectId: 'prj_1' }, limit: 10, offset: 0 });
    expect(ids(listed.rows)).toEqual(['brd_p1', 'wb_old', 'wb_older']);
    expect(listed.total).toBe(3);
    expect(listed.rows[1]).toMatchObject({ legacy: true, fileId: null, file: null, projectId: 'prj_1', updatedById: 'bob', revision: 0 });
    expect(isLive(listed.rows[1]!)).toBe(false);
    const page = await listBoards(db, { scope: { kind: 'project', projectId: 'prj_1' }, search: 'old', limit: 1, offset: 1 });
    expect(ids(page.rows)).toEqual(['wb_older']);
    expect(page.total).toBe(2);
  });

  it('lists the boards of the projects the caller may open, or of every live project', async () => {
    const some = await listBoards(db, { scope: { kind: 'projects', projectIds: ['prj_2'] }, limit: 10, offset: 0 });
    expect(ids(some.rows)).toEqual(['brd_p2']);
    const none = await listBoards(db, { scope: { kind: 'projects', projectIds: [] }, limit: 10, offset: 0 });
    expect(none).toEqual({ rows: [], total: 0 });
    const live = await listBoards(db, { scope: { kind: 'projects', projectIds: null }, limit: 10, offset: 0 });
    expect(ids(live.rows)).toEqual(['brd_p2', 'brd_p1', 'wb_old', 'wb_older']);
  });

  it('narrows the list to what the caller may see', async () => {
    const visible = eq(files.uploadedById, 'nobody');
    expect(await listBoards(db, { scope: { kind: 'drive' }, visible, limit: 10, offset: 0 })).toEqual({ rows: [], total: 0 });
  });
});

describe('old WeldFlow whiteboards', () => {
  beforeEach(async () => {
    await project('prj_1');
    await legacy('wb_1', 'prj_1', 'Planning', 60);
  });

  it('reads one, and its elements, until it is converted', async () => {
    const found = await getBoard(db, 'wb_1');
    expect(found).toMatchObject({ id: 'wb_1', legacy: true, name: 'Planning' });
    expect(await getLiveBoard(db, 'wb_1')).toBeNull();
    expect(await legacyElements(db, 'wb_1')).toEqual({ elements: [{ type: 'rectangle' }], lastEditedBy: 'bob' });
    await legacy('wb_2', 'prj_1', 'Empty', 60, null);
    expect(await legacyElements(db, 'wb_2')).toEqual({ elements: [], lastEditedBy: 'bob' });
    expect(await legacyElements(db, 'wb_missing')).toBeNull();
  });

  it('converts one in place, keeping its id and project', async () => {
    const old = (await getBoard(db, 'wb_1'))!;
    const converted = await convertLegacy(db, { legacy: old, workspaceId: WORKSPACE, snapshotSize: 42, userId: 'alice' });
    expect(converted).toMatchObject({ id: 'wb_1', legacy: false, name: 'Planning', projectId: 'prj_1', createdById: 'bob', snapshotKey: snapshotKeyFor(WORKSPACE, 'wb_1') });
    const [oldRow] = await db.select().from(projectWhiteboards).where(eq(projectWhiteboards.id, 'wb_1'));
    expect(oldRow!.deletedAt).not.toBeNull();
    expect(await getBoard(db, 'wb_1')).toMatchObject({ legacy: false });

    // Someone else's convert got there first: theirs stands.
    expect(await convertLegacy(db, { legacy: old, workspaceId: WORKSPACE, snapshotSize: 42, userId: 'carol' })).toBeNull();
    // A board that is no old whiteboard is not converted.
    await expect(convertLegacy(db, { legacy: converted!, workspaceId: WORKSPACE, snapshotSize: 1, userId: 'alice' })).rejects.toThrow('not an old WeldFlow whiteboard');
  });

  it('passes on a failure that was not a lost race', async () => {
    const old = (await getBoard(db, 'wb_1'))!;
    // A row the database refuses (no valid creation time): no board took its place either.
    const orphan = { ...old, createdAt: new Date(Number.NaN) };
    await expect(convertLegacy(db, { legacy: orphan, workspaceId: WORKSPACE, snapshotSize: 1, userId: 'alice' })).rejects.toThrow();
  });

  it('trashes one that was never converted', async () => {
    expect(await trashLegacy(db, 'wb_1')).toBe(true);
    expect(await trashLegacy(db, 'wb_1')).toBe(false);
    expect(await getBoard(db, 'wb_1')).toBeNull();
  });
});

describe('changing boards', () => {
  let roadmap: LiveBoardRecord;

  beforeEach(async () => {
    roadmap = await board('brd_1', 'Roadmap');
    await board('brd_2', 'Taken');
  });

  it('renames a board, and refuses a name its folder already has', async () => {
    const renamed = await updateBoard(db, roadmap, { name: 'Plan' });
    expect(renamed).toMatchObject({ ok: true, board: { name: 'Plan' }, previous: { fileName: 'Roadmap' } });
    expect(await updateBoard(db, roadmap, { name: 'Taken' })).toEqual({ ok: false, reason: 'name_conflict' });
  });

  it('makes a board a template and back, leaving its name alone', async () => {
    const made = await updateBoard(db, roadmap, { template: { category: 'planning' } });
    expect(made).toMatchObject({ ok: true, board: { name: 'Roadmap', templateCategory: 'planning' }, previous: null });
    expect(await updateBoard(db, roadmap, { template: null })).toMatchObject({ ok: true, board: { templateCategory: null } });
  });

  it('trashes a board, which then cannot be changed', async () => {
    expect(await trashBoard(db, roadmap)).toBe(true);
    expect(await getBoard(db, 'brd_1')).toBeNull();
    expect(await updateBoard(db, roadmap, { name: 'Again' })).toEqual({ ok: false, reason: 'not_found' });
    expect(await updateBoard(db, roadmap, { template: null })).toEqual({ ok: false, reason: 'not_found' });
    expect(await trashBoard(db, roadmap)).toBe(false);
  });

  it('records checkpoints, crediting people but not the server', async () => {
    const byBob = await recordCheckpoint(db, 'brd_1', { revision: 5, snapshotKey: roadmap.snapshotKey!, size: 1234, userId: 'bob' });
    expect(byBob).toMatchObject({ revision: 5, updatedById: 'bob' });
    const [file] = await db.select().from(files).where(eq(files.id, roadmap.fileId));
    expect(file!.fileSize).toBe(1234);
    const byServer = await recordCheckpoint(db, 'brd_1', { revision: 6, snapshotKey: roadmap.snapshotKey!, size: 1300, userId: 'server:agent' });
    expect(byServer).toMatchObject({ revision: 6, updatedById: 'bob' });
    expect(await recordCheckpoint(db, 'brd_1', { revision: 7, snapshotKey: roadmap.snapshotKey!, size: 1300, userId: null })).toMatchObject({ revision: 7, updatedById: 'bob' });
    expect(await recordCheckpoint(db, 'brd_missing', { revision: 1, snapshotKey: 'k', size: 1, userId: 'bob' })).toBeNull();
  });
});

describe('projectExists', () => {
  it('knows live projects only', async () => {
    await project('prj_live');
    await project('prj_deleted', true);
    expect(await projectExists(db, 'prj_live')).toBe(true);
    expect(await projectExists(db, 'prj_deleted')).toBe(false);
    expect(await projectExists(db, 'prj_missing')).toBe(false);
  });
});
