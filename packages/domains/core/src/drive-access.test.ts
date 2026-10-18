/**
 * pglite-backed tests for the WeldDrive sharing rules: who sees a file or
 * folder and at what role, and that the SQL form the public API paginates
 * with gives the same answer as the in-memory one.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import {
  containerRole,
  fileRole,
  folderRole,
  listSharedWithUser,
  loadDriveAccess,
  loadDriveAccessForUser,
  upsertShare,
  visibleFilesCondition,
  visibleFolderIds,
  type DriveCaller,
  type DriveGeneralAccess,
} from './drive-access';

const { files, folders, workspaceMembers } = schema;

const ANN = 'user_ann'; // owns most of the drive
const BOB = 'user_bob'; // gets things shared with him
const CAROL = 'user_carol'; // a member nothing is shared with
const ADMIN = 'user_admin';

let db: Database;

async function member(userId: string, role = 'MEMBER') {
  const now = new Date();
  await db.insert(workspaceMembers).values({
    id: `wm_${userId}`,
    userId,
    email: `${userId}@test.dev`,
    role,
    createdAt: now,
    updatedAt: now,
  } as typeof workspaceMembers.$inferInsert);
}

async function folder(id: string, opts: { parentId?: string; owner?: string; access?: DriveGeneralAccess } = {}) {
  const now = new Date();
  await db.insert(folders).values({
    id,
    name: id,
    parentId: opts.parentId ?? null,
    createdById: opts.owner ?? ANN,
    generalAccess: opts.access ?? 'workspace_edit',
    createdAt: now,
    updatedAt: now,
  });
}

async function file(
  id: string,
  opts: { folderId?: string; owner?: string | null; access?: DriveGeneralAccess; entityType?: string; deleted?: boolean } = {},
) {
  const now = new Date();
  await db.insert(files).values({
    id,
    fileName: `${id}.txt`,
    mimeType: 'text/plain',
    fileSize: 1,
    storagePath: `workspaces/w/${id}`,
    folderId: opts.folderId ?? null,
    uploadedById: opts.owner === undefined ? ANN : opts.owner,
    generalAccess: opts.access ?? 'workspace_edit',
    entityType: opts.entityType ?? null,
    deletedAt: opts.deleted ? now : null,
    createdAt: now,
    updatedAt: now,
  });
}

const caller = (userId: string | null, isAdmin = false): DriveCaller => ({ userId, isAdmin });

async function roleOnFile(who: DriveCaller, id: string) {
  const index = await loadDriveAccess(db, who);
  const [row] = await db.select().from(files).where(eq(files.id, id));
  return fileRole(index, row!);
}

async function roleOnFolder(who: DriveCaller, id: string) {
  const index = await loadDriveAccess(db, who);
  return folderRole(index, index.folders.get(id)!);
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await member(ANN);
  await member(BOB);
  await member(CAROL);
  await member(ADMIN, 'ADMIN');

  // My Drive
  await file('fil_open'); // workspace_edit
  await file('fil_readonly', { access: 'workspace_view' });
  await file('fil_private', { access: 'restricted' });
  await file('fil_private_shared', { access: 'restricted' });
  await file('fil_module', { access: 'restricted', entityType: 'project' });
  await file('fil_trashed_shared', { access: 'restricted', deleted: true });
  await file('fil_orphan', { owner: null, access: 'restricted' });

  // A restricted folder with a subfolder and files that keep the default.
  await folder('fld_hr', { access: 'restricted' });
  await folder('fld_hr_2026', { parentId: 'fld_hr' });
  await file('fil_in_hr', { folderId: 'fld_hr' });
  await file('fil_in_hr_2026', { folderId: 'fld_hr_2026' });

  // A view-only folder, and a folder Bob owns inside Ann's restricted one.
  await folder('fld_policies', { access: 'workspace_view' });
  await file('fil_policy', { folderId: 'fld_policies' });
  await folder('fld_bob_inside', { parentId: 'fld_hr', owner: BOB });
  await file('fil_ann_in_bob_folder', { folderId: 'fld_bob_inside' });

  await upsertShare(db, { kind: 'file', id: 'fil_private_shared' }, { userId: BOB, role: 'viewer', sharedBy: ANN });
  await upsertShare(db, { kind: 'file', id: 'fil_trashed_shared' }, { userId: BOB, role: 'editor', sharedBy: ANN });
  await upsertShare(db, { kind: 'folder', id: 'fld_hr_2026' }, { userId: CAROL, role: 'editor', sharedBy: ANN });
}, 60_000);

describe('fileRole', () => {
  it('makes the uploader the owner', async () => {
    expect(await roleOnFile(caller(ANN), 'fil_private')).toBe('owner');
  });

  it('opens the default to everyone as editor, today\'s behaviour', async () => {
    expect(await roleOnFile(caller(CAROL), 'fil_open')).toBe('editor');
  });

  it('opens a view-only file to everyone as viewer', async () => {
    expect(await roleOnFile(caller(CAROL), 'fil_readonly')).toBe('viewer');
  });

  it('hides a restricted file from a member it was not shared with', async () => {
    expect(await roleOnFile(caller(CAROL), 'fil_private')).toBeNull();
  });

  it('gives the shared-with member their role on a restricted file', async () => {
    expect(await roleOnFile(caller(BOB), 'fil_private_shared')).toBe('viewer');
    expect(await roleOnFile(caller(CAROL), 'fil_private_shared')).toBeNull();
  });

  it('restricts a default file inside a restricted folder, all the way down', async () => {
    expect(await roleOnFile(caller(BOB), 'fil_in_hr')).toBeNull();
    expect(await roleOnFile(caller(BOB), 'fil_in_hr_2026')).toBeNull();
  });

  it('reaches into a folder through a share on it', async () => {
    expect(await roleOnFile(caller(CAROL), 'fil_in_hr_2026')).toBe('editor');
    expect(await roleOnFile(caller(CAROL), 'fil_in_hr')).toBeNull();
  });

  it('lets a folder\'s owner edit what others put in it', async () => {
    expect(await roleOnFile(caller(BOB), 'fil_ann_in_bob_folder')).toBe('editor');
  });

  it('makes a file in a view-only folder view-only', async () => {
    expect(await roleOnFile(caller(CAROL), 'fil_policy')).toBe('viewer');
  });

  it('opens everything to workspace admins as editor', async () => {
    expect(await roleOnFile(caller(ADMIN, true), 'fil_private')).toBe('editor');
    expect(await roleOnFile(caller(ADMIN, true), 'fil_orphan')).toBe('editor');
  });

  it('leaves a module\'s file to that module', async () => {
    expect(await roleOnFile(caller(CAROL), 'fil_module')).toBe('editor');
  });

  it('shows a workspace key only what is not restricted', async () => {
    expect(await roleOnFile(caller(null), 'fil_open')).toBe('editor');
    expect(await roleOnFile(caller(null), 'fil_readonly')).toBe('viewer');
    expect(await roleOnFile(caller(null), 'fil_private')).toBeNull();
    expect(await roleOnFile(caller(null), 'fil_in_hr')).toBeNull();
  });

  it('looks up the admin role from the member row', async () => {
    const index = await loadDriveAccessForUser(db, ADMIN);
    expect(index.caller.isAdmin).toBe(true);
    expect((await loadDriveAccessForUser(db, BOB)).caller.isAdmin).toBe(false);
  });
});

describe('folderRole and containerRole', () => {
  it('hides a restricted folder and its subfolders from others', async () => {
    expect(await roleOnFolder(caller(BOB), 'fld_hr')).toBeNull();
    expect(await roleOnFolder(caller(CAROL), 'fld_hr')).toBeNull();
  });

  it('gives a shared folder\'s role to the member it is shared with', async () => {
    expect(await roleOnFolder(caller(CAROL), 'fld_hr_2026')).toBe('editor');
  });

  it('lets anyone add to My Drive, and only editors add to a folder', async () => {
    const carol = await loadDriveAccess(db, caller(CAROL));
    expect(containerRole(carol, null)).toBe('editor');
    expect(containerRole(carol, 'fld_policies')).toBe('viewer');
    expect(containerRole(carol, 'fld_hr')).toBeNull();
    expect(containerRole(carol, 'fld_hr_2026')).toBe('editor');
  });
});

describe('visibleFilesCondition and visibleFolderIds', () => {
  it.each([
    ['Ann', caller(ANN)],
    ['Bob', caller(BOB)],
    ['Carol', caller(CAROL)],
    ['an admin', caller(ADMIN, true)],
    ['a workspace key', caller(null)],
  ])('selects in SQL exactly the files fileRole lets %s see', async (_name, who) => {
    const index = await loadDriveAccess(db, who);
    const live = await db.select().from(files).where(isNull(files.deletedAt));
    const expected = live.filter((row) => fileRole(index, row)).map((row) => row.id).sort();
    const condition = visibleFilesCondition(index);
    const selected = await db.select({ id: files.id }).from(files).where(and(isNull(files.deletedAt), condition));
    expect(selected.map((row) => row.id).sort()).toEqual(expected);
  });

  it('lists the folders a member may see', async () => {
    const ids = visibleFolderIds(await loadDriveAccess(db, caller(CAROL)));
    expect(ids.sort()).toEqual(['fld_hr_2026', 'fld_policies']);
  });
});

describe('listSharedWithUser', () => {
  it('lists the live items others shared with the member', async () => {
    const bob = await listSharedWithUser(db, BOB);
    expect(bob.files.map((s) => s.file.id)).toEqual(['fil_private_shared']);
    expect(bob.files[0]?.role).toBe('viewer');
    expect(bob.folders).toEqual([]);

    const carol = await listSharedWithUser(db, CAROL);
    expect(carol.folders.map((s) => s.folder.id)).toEqual(['fld_hr_2026']);
    expect((await listSharedWithUser(db, ANN)).files).toEqual([]);
  });

  it('changes the role when the item is shared again', async () => {
    const { previousRole } = await upsertShare(db, { kind: 'file', id: 'fil_private_shared' }, { userId: BOB, role: 'editor', sharedBy: ANN });
    expect(previousRole).toBe('viewer');
    expect(await roleOnFile(caller(BOB), 'fil_private_shared')).toBe('editor');
    await upsertShare(db, { kind: 'file', id: 'fil_private_shared' }, { userId: BOB, role: 'viewer', sharedBy: ANN });
  });
});
