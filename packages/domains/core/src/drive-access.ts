/**
 * WeldDrive access rules, shared by every worker that reads or writes Drive
 * items (app-api /api/files, /api/folders, /api/drive; flow-api
 * /api/documents; external-api and mcp-server /v1/files, /v1/folders).
 *
 * `files:*` / `folders:*` open the door to Drive. Which items a caller sees
 * inside it, and at what role, is decided here:
 *
 *   - the uploader of a file, or the creator of a folder, owns it;
 *   - whoever owns a folder edits everything inside it;
 *   - a share (`drive_shares`) on the item or on a folder above it gives its
 *     role; the highest role wins;
 *   - `general_access` opens the item to the rest of the workspace. The
 *     strictest setting on the way up the folder tree applies, so a file in
 *     a restricted folder is restricted too;
 *   - workspace OWNER / ADMIN open every item at editor, so a former
 *     member's restricted files stay reachable;
 *   - a caller with no person behind it (a workspace API key) sees items
 *     that are not restricted only.
 *
 * Files a module keeps for one of its records (`entityType` set: WeldFlow
 * sheets and documents, CRM attachments, …) are outside these rules: their
 * module decides who opens them, as before.
 *
 * An item the caller cannot see answers 404, never 403.
 */

import { and, eq, inArray, isNotNull, isNull, ne, or, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { DriveGeneralAccess, DriveShareRole } from '@weldsuite/db/schema';

const { files, folders, driveShares, workspaceMembers } = schema;

export type { DriveGeneralAccess, DriveShareRole };

/** A caller's role on a Drive item. `owner` and `editor` change and share it. */
export type DriveRole = 'owner' | 'editor' | 'viewer';

const ROLE_RANK: Record<DriveRole, number> = { viewer: 1, editor: 2, owner: 3 };
const GENERAL_RANK: Record<DriveGeneralAccess, number> = { restricted: 0, workspace_view: 1, workspace_edit: 2 };

/** Folders walked up from an item before giving up; guards against a loop already in the data. */
const MAX_FOLDER_DEPTH = 64;

export interface DriveCaller {
  /** The person asking, or null for a workspace API key. */
  userId: string | null;
  /** Workspace OWNER / ADMIN: opens every item at editor. */
  isAdmin: boolean;
}

interface FolderNode {
  id: string;
  parentId: string | null;
  createdById: string | null;
  generalAccess: DriveGeneralAccess;
}

/**
 * What the rules need to answer for one caller: every folder (the tree is
 * small next to the files in it) and the caller's own shares. Load it once
 * per request with `loadDriveAccess`, then ask about as many items as needed.
 */
export interface DriveAccessIndex {
  caller: DriveCaller;
  folders: Map<string, FolderNode>;
  fileShares: Map<string, DriveShareRole>;
  folderShares: Map<string, DriveShareRole>;
}

/** The fields of a `files` row the rules read. */
export type DriveFileRef = Pick<typeof files.$inferSelect, 'id' | 'uploadedById' | 'folderId' | 'generalAccess' | 'entityType'>;

/** The fields of a `folders` row the rules read. */
export type DriveFolderRef = Pick<typeof folders.$inferSelect, 'id' | 'parentId' | 'createdById' | 'generalAccess'>;

export async function loadDriveAccess(db: Database, caller: DriveCaller): Promise<DriveAccessIndex> {
  const [folderRows, shareRows] = await Promise.all([
    // Trashed folders too: a trashed file is judged by the tree it was in.
    db
      .select({
        id: folders.id,
        parentId: folders.parentId,
        createdById: folders.createdById,
        generalAccess: folders.generalAccess,
      })
      .from(folders),
    caller.userId
      ? db
          .select({ fileId: driveShares.fileId, folderId: driveShares.folderId, role: driveShares.role })
          .from(driveShares)
          .where(eq(driveShares.userId, caller.userId))
      : Promise.resolve([]),
  ]);

  const fileShares = new Map<string, DriveShareRole>();
  const folderShares = new Map<string, DriveShareRole>();
  for (const share of shareRows) {
    if (share.fileId) fileShares.set(share.fileId, share.role);
    else if (share.folderId) folderShares.set(share.folderId, share.role);
  }
  return {
    caller,
    folders: new Map(folderRows.map((row) => [row.id, row])),
    fileShares,
    folderShares,
  };
}

function higher(a: DriveRole | null, b: DriveRole | null): DriveRole | null {
  if (!a) return b;
  if (!b) return a;
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

function stricter(a: DriveGeneralAccess, b: DriveGeneralAccess): DriveGeneralAccess {
  return GENERAL_RANK[a] <= GENERAL_RANK[b] ? a : b;
}

function workspaceRole(access: DriveGeneralAccess): DriveRole | null {
  if (access === 'workspace_edit') return 'editor';
  if (access === 'workspace_view') return 'viewer';
  return null;
}

/** An item's own grants, before the folders above it are walked. */
interface ItemGrants {
  ownerId: string | null;
  generalAccess: DriveGeneralAccess;
  share: DriveShareRole | undefined;
  parentId: string | null;
}

/** What the folders from `folderId` up give to everything inside `folderId`. */
interface ContainerChain {
  /** The caller's own role from the chain: owning a folder in it (editor), or a share on one. */
  grant: DriveRole | null;
  /** The strictest general access on the chain; My Drive itself is open. */
  general: DriveGeneralAccess;
}

function containerChain(index: DriveAccessIndex, folderId: string | null): ContainerChain {
  const { userId } = index.caller;
  let grant: DriveRole | null = null;
  let general: DriveGeneralAccess = 'workspace_edit';
  const seen = new Set<string>();
  let current = folderId;
  for (let depth = 0; current && depth < MAX_FOLDER_DEPTH && !seen.has(current); depth++) {
    seen.add(current);
    const folder = index.folders.get(current);
    if (!folder) break;
    if (userId && folder.createdById === userId) grant = higher(grant, 'editor');
    grant = higher(grant, index.folderShares.get(folder.id) ?? null);
    general = stricter(general, folder.generalAccess);
    current = folder.parentId;
  }
  return { grant, general };
}

/** The general access that applies to an item: its own, or a stricter one above it. */
function effectiveGeneralAccess(index: DriveAccessIndex, own: DriveGeneralAccess, parentId: string | null): DriveGeneralAccess {
  return stricter(own, containerChain(index, parentId).general);
}

function roleFor(index: DriveAccessIndex, item: ItemGrants): DriveRole | null {
  const { userId, isAdmin } = index.caller;
  if (userId && item.ownerId === userId) return 'owner';

  const chain = containerChain(index, item.parentId);
  let role = higher(item.share ?? null, chain.grant);
  role = higher(role, workspaceRole(stricter(item.generalAccess, chain.general)));
  if (isAdmin) role = higher(role, 'editor');
  return role;
}

/** True for a file a module keeps for one of its records, which these rules leave alone. */
export function isModuleFile(file: Pick<DriveFileRef, 'entityType'>): boolean {
  return !!file.entityType;
}

/** The caller's role on a file, or null when they may not see it. */
export function fileRole(index: DriveAccessIndex, file: DriveFileRef): DriveRole | null {
  if (isModuleFile(file)) {
    return index.caller.userId && file.uploadedById === index.caller.userId ? 'owner' : 'editor';
  }
  return roleFor(index, {
    ownerId: file.uploadedById,
    generalAccess: file.generalAccess,
    share: index.fileShares.get(file.id),
    parentId: file.folderId,
  });
}

/** The caller's role on a folder (and so on what is in it), or null when they may not see it. */
export function folderRole(index: DriveAccessIndex, folder: DriveFolderRef): DriveRole | null {
  return roleFor(index, {
    ownerId: folder.createdById,
    generalAccess: folder.generalAccess,
    share: index.folderShares.get(folder.id),
    parentId: folder.parentId,
  });
}

/** The caller's role on whatever goes into `folderId`: a new file or subfolder. My Drive (null) is open to all. */
export function containerRole(index: DriveAccessIndex, folderId: string | null): DriveRole | null {
  if (!folderId) return 'editor';
  const folder = index.folders.get(folderId);
  return folder ? folderRole(index, folder) : null;
}

/** May this role change the item and its sharing? */
export function canEdit(role: DriveRole | null): role is 'owner' | 'editor' {
  return role === 'owner' || role === 'editor';
}

/** The general access in force for a file, once the folders above it are counted. */
export function effectiveFileAccess(index: DriveAccessIndex, file: DriveFileRef): DriveGeneralAccess {
  if (isModuleFile(file)) return 'workspace_edit';
  return effectiveGeneralAccess(index, file.generalAccess, file.folderId);
}

/** The general access in force for a folder, once the folders above it are counted. */
export function effectiveFolderAccess(index: DriveAccessIndex, folder: DriveFolderRef): DriveGeneralAccess {
  return effectiveGeneralAccess(index, folder.generalAccess, folder.parentId);
}

/**
 * WHERE clause for the `files` rows the caller may see: the same answer as
 * `fileRole`, for lists paginated in SQL (the public API). Undefined when
 * the caller sees every file.
 */
export function visibleFilesCondition(index: DriveAccessIndex): SQL | undefined {
  const { userId, isAdmin } = index.caller;
  if (isAdmin) return undefined;
  // Folders whose files the caller reaches through the chain, and folders
  // whose chain leaves their files open to the workspace.
  const granted: string[] = [];
  const open: string[] = [];
  for (const id of index.folders.keys()) {
    const chain = containerChain(index, id);
    if (chain.grant) granted.push(id);
    if (chain.general !== 'restricted') open.push(id);
  }
  const fileShareIds = [...index.fileShares.keys()];
  const conditions: (SQL | undefined)[] = [
    isNotNull(files.entityType),
    userId ? eq(files.uploadedById, userId) : undefined,
    fileShareIds.length > 0 ? inArray(files.id, fileShareIds) : undefined,
    granted.length > 0 ? inArray(files.folderId, granted) : undefined,
    and(
      ne(files.generalAccess, 'restricted'),
      open.length > 0 ? or(isNull(files.folderId), inArray(files.folderId, open)) : isNull(files.folderId),
    ),
  ];
  return or(...conditions.filter((cond): cond is SQL => !!cond));
}

/** The ids of the folders the caller may see. */
export function visibleFolderIds(index: DriveAccessIndex): string[] {
  const ids: string[] = [];
  for (const folder of index.folders.values()) {
    if (folderRole(index, folder)) ids.push(folder.id);
  }
  return ids;
}

/** What a caller is told about their access to an item they can see. */
export interface DriveAccessFields {
  /** The caller's role on the item. */
  accessRole: DriveRole;
  /** The general access in force, once the folders above the item are counted. */
  effectiveAccess: DriveGeneralAccess;
}

/** `rows` the caller may see, each with their role on it and the access in force. */
export function withFileAccess<T extends DriveFileRef>(index: DriveAccessIndex, rows: T[]): (T & DriveAccessFields)[] {
  const out: (T & DriveAccessFields)[] = [];
  for (const row of rows) {
    const accessRole = fileRole(index, row);
    if (accessRole) out.push({ ...row, accessRole, effectiveAccess: effectiveFileAccess(index, row) });
  }
  return out;
}

/** `rows` the caller may see, each with their role on it and the access in force. */
export function withFolderAccess<T extends DriveFolderRef>(index: DriveAccessIndex, rows: T[]): (T & DriveAccessFields)[] {
  const out: (T & DriveAccessFields)[] = [];
  for (const row of rows) {
    const accessRole = folderRole(index, row);
    if (accessRole) out.push({ ...row, accessRole, effectiveAccess: effectiveFolderAccess(index, row) });
  }
  return out;
}

// ============================================================================
// Callers
// ============================================================================

/** Is `userId` a workspace OWNER or ADMIN? */
export async function isWorkspaceAdmin(db: Database, userId: string): Promise<boolean> {
  const [member] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.deletedAt)))
    .limit(1);
  const role = member?.role?.toUpperCase();
  return role === 'OWNER' || role === 'ADMIN';
}

/**
 * The rules for a caller known only by id: a person (admin looked up here),
 * or null for a workspace API key. Workers that have the member's resolved
 * permissions at hand can build the `DriveCaller` themselves and save the query.
 */
export async function loadDriveAccessForUser(db: Database, userId: string | null): Promise<DriveAccessIndex> {
  const isAdmin = userId ? await isWorkspaceAdmin(db, userId) : false;
  return loadDriveAccess(db, { userId, isAdmin });
}

/** May `userId` be shared with: an active member of this workspace? */
export async function isShareableMember(db: Database, userId: string): Promise<boolean> {
  const [member] = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        eq(workspaceMembers.status, 'ACTIVE'),
        isNull(workspaceMembers.deletedAt),
      ),
    )
    .limit(1);
  return !!member;
}

// ============================================================================
// Shares
// ============================================================================

/** A Drive item addressed by kind and id. */
export type DriveItemRef = { kind: 'file'; id: string } | { kind: 'folder'; id: string };

function itemCondition(item: DriveItemRef) {
  return item.kind === 'file' ? eq(driveShares.fileId, item.id) : eq(driveShares.folderId, item.id);
}

export interface DriveShareEntry {
  userId: string;
  role: DriveShareRole;
  sharedBy: string;
  createdAt: Date;
  name: string | null;
  email: string | null;
  picture: string | null;
}

/** An access entry the item gets from a folder above it. */
export interface InheritedDriveShare extends DriveShareEntry {
  folderId: string;
  folderName: string;
}

const shareColumns = {
  userId: driveShares.userId,
  role: driveShares.role,
  sharedBy: driveShares.sharedBy,
  createdAt: driveShares.createdAt,
  name: workspaceMembers.name,
  email: workspaceMembers.email,
  picture: workspaceMembers.picture,
};

/** The people an item is shared with directly, oldest first. */
export async function listItemShares(db: Database, item: DriveItemRef): Promise<DriveShareEntry[]> {
  return db
    .select(shareColumns)
    .from(driveShares)
    .leftJoin(workspaceMembers, and(eq(workspaceMembers.userId, driveShares.userId), isNull(workspaceMembers.deletedAt)))
    .where(itemCondition(item))
    .orderBy(driveShares.createdAt);
}

/** The folders above `parentId`, nearest first. */
export function ancestorFolderIds(index: DriveAccessIndex, parentId: string | null): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  let current = parentId;
  for (let depth = 0; current && depth < MAX_FOLDER_DEPTH && !seen.has(current); depth++) {
    seen.add(current);
    const folder = index.folders.get(current);
    if (!folder) break;
    ids.push(folder.id);
    current = folder.parentId;
  }
  return ids;
}

/** The people who reach an item through a share on a folder above it. */
export async function listInheritedShares(db: Database, folderIds: string[]): Promise<InheritedDriveShare[]> {
  if (folderIds.length === 0) return [];
  const rows = await db
    .select({ ...shareColumns, folderId: driveShares.folderId, folderName: folders.name })
    .from(driveShares)
    .innerJoin(folders, eq(folders.id, driveShares.folderId))
    .leftJoin(workspaceMembers, and(eq(workspaceMembers.userId, driveShares.userId), isNull(workspaceMembers.deletedAt)))
    .where(inArray(driveShares.folderId, folderIds))
    .orderBy(driveShares.createdAt);
  return rows.map((row) => ({ ...row, folderId: row.folderId! }));
}

/**
 * Share an item with `userId` at `role`, or change the role they already
 * have. `previousRole` is null for a new share.
 */
export async function upsertShare(
  db: Database,
  item: DriveItemRef,
  input: { userId: string; role: DriveShareRole; sharedBy: string },
): Promise<{ previousRole: DriveShareRole | null }> {
  const [existing] = await db
    .select({ id: driveShares.id, role: driveShares.role })
    .from(driveShares)
    .where(and(itemCondition(item), eq(driveShares.userId, input.userId)))
    .limit(1);
  const now = new Date();
  if (existing) {
    if (existing.role !== input.role) {
      await db.update(driveShares).set({ role: input.role, updatedAt: now }).where(eq(driveShares.id, existing.id));
    }
    return { previousRole: existing.role };
  }
  await db.insert(driveShares).values({
    id: generateId('dsh'),
    fileId: item.kind === 'file' ? item.id : null,
    folderId: item.kind === 'folder' ? item.id : null,
    userId: input.userId,
    role: input.role,
    sharedBy: input.sharedBy,
    createdAt: now,
    updatedAt: now,
  });
  return { previousRole: null };
}

/** A Drive item with the fields its sharing summary needs. */
export type DriveSharingTarget = DriveItemRef & {
  ownerId: string | null;
  generalAccess: DriveGeneralAccess;
  parentId: string | null;
};

export interface DriveSharePerson {
  userId: string;
  name: string | null;
  email: string | null;
  picture: string | null;
}

/** Everything the Share dialog shows about an item. */
export interface DriveItemSharing {
  owner: DriveSharePerson | null;
  generalAccess: DriveGeneralAccess;
  effectiveGeneralAccess: DriveGeneralAccess;
  accessRole: DriveRole;
  shares: DriveShareEntry[];
  inherited: InheritedDriveShare[];
}

async function memberPerson(db: Database, userId: string): Promise<DriveSharePerson> {
  const [member] = await db
    .select({ name: workspaceMembers.name, email: workspaceMembers.email, picture: workspaceMembers.picture })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.deletedAt)))
    .limit(1);
  return { userId, name: member?.name ?? null, email: member?.email ?? null, picture: member?.picture ?? null };
}

/** Who an item is open to, for a caller whose role on it is `accessRole`. */
export async function describeSharing(
  db: Database,
  index: DriveAccessIndex,
  target: DriveSharingTarget,
  accessRole: DriveRole,
): Promise<DriveItemSharing> {
  const [shares, inherited, owner] = await Promise.all([
    listItemShares(db, target),
    listInheritedShares(db, ancestorFolderIds(index, target.parentId)),
    target.ownerId ? memberPerson(db, target.ownerId) : Promise.resolve(null),
  ]);
  return {
    owner,
    generalAccess: target.generalAccess,
    effectiveGeneralAccess: effectiveGeneralAccess(index, target.generalAccess, target.parentId),
    accessRole,
    shares,
    inherited,
  };
}

/** Stop sharing an item with `userId`; the role they had, or null if it was not shared with them. */
export async function removeShare(db: Database, item: DriveItemRef, userId: string): Promise<DriveShareRole | null> {
  const [removed] = await db
    .delete(driveShares)
    .where(and(itemCondition(item), eq(driveShares.userId, userId)))
    .returning({ role: driveShares.role });
  return removed?.role ?? null;
}

/** What "Shared with me" lists: live items someone else shared with `userId`, newest share first. */
export async function listSharedWithUser(db: Database, userId: string) {
  const [sharedFiles, sharedFolders] = await Promise.all([
    db
      .select({
        file: files,
        role: driveShares.role,
        sharedBy: driveShares.sharedBy,
        sharedAt: driveShares.createdAt,
      })
      .from(driveShares)
      .innerJoin(files, eq(files.id, driveShares.fileId))
      .where(and(eq(driveShares.userId, userId), ne(driveShares.sharedBy, userId), isNull(files.deletedAt)))
      .orderBy(driveShares.createdAt),
    db
      .select({
        folder: folders,
        role: driveShares.role,
        sharedBy: driveShares.sharedBy,
        sharedAt: driveShares.createdAt,
      })
      .from(driveShares)
      .innerJoin(folders, eq(folders.id, driveShares.folderId))
      .where(and(eq(driveShares.userId, userId), ne(driveShares.sharedBy, userId), isNull(folders.deletedAt)))
      .orderBy(driveShares.createdAt),
  ]);
  return { files: sharedFiles.reverse(), folders: sharedFolders.reverse() };
}
