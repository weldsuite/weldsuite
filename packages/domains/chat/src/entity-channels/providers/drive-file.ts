import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { fileRole, loadDriveAccessForUser, type DriveFileRef } from '@weldsuite/core-domain/drive-access';
import {
  canAccessViaFilter,
  registerEntityProvider,
  type EntityChannelProvider,
  type EntityVisibilityContext,
} from '../registry';
import { projectEntityProvider } from './project';

/**
 * Spreadsheet and document chats (WeldSheets, WeldDocs).
 *
 * The chat of a sheet or a document holds its comment threads: each thread
 * on a cell or a stretch of text is a WeldChat thread whose messages carry
 * the thread's id in `metadata.anchor`, and the file keeps only where it is
 * (ADR CHAT-007).
 *
 * The record is a WeldDrive file, so who may see its chat is who may open
 * the file: a Drive role on it, and for a WeldFlow project's file the
 * project's own rule (as sheets-api's `findSheet` applies). The file's owner
 * follows a new chat; everyone else follows by commenting or being mentioned.
 */

/** Files kept by WeldFlow projects carry this entity type (sheets-api `PROJECT_ENTITY`). */
const PROJECT_ENTITY = 'project';

interface FileRecord {
  id: string;
  name: string;
  file: DriveFileRef;
  /** The project the file belongs to, or null. */
  projectId: string | null;
}

type Loader = (db: Database, ids: string[]) => Promise<FileRecord[]>;

const fileColumns = () => {
  const { files } = schema;
  return {
    name: files.fileName,
    fileId: files.id,
    uploadedById: files.uploadedById,
    folderId: files.folderId,
    generalAccess: files.generalAccess,
    entityType: files.entityType,
    entityId: files.entityId,
  };
};

type FileColumns = { name: string; fileId: string; uploadedById: string | null; folderId: string | null; generalAccess: DriveFileRef['generalAccess']; entityType: string | null; entityId: string | null };

function toRecord(id: string, r: FileColumns): FileRecord {
  return {
    id,
    name: r.name,
    file: { id: r.fileId, uploadedById: r.uploadedById, folderId: r.folderId, generalAccess: r.generalAccess, entityType: r.entityType },
    projectId: r.entityType === PROJECT_ENTITY ? r.entityId : null,
  };
}

/** Live spreadsheets (their file not in the trash). */
const loadSheets: Loader = async (db, ids) => {
  if (ids.length === 0) return [];
  const { files, sheets } = schema;
  const rows = await db
    .select({ id: sheets.id, ...fileColumns() })
    .from(sheets)
    .innerJoin(files, eq(files.id, sheets.fileId))
    .where(and(inArray(sheets.id, ids), isNull(files.deletedAt)));
  return rows.map((r) => toRecord(r.id, r));
};

/** Live documents (WeldDocs ones, their file not in the trash). */
const loadDocs: Loader = async (db, ids) => {
  if (ids.length === 0) return [];
  const { files, docs } = schema;
  const rows = await db
    .select({ id: docs.id, ...fileColumns() })
    .from(docs)
    .innerJoin(files, eq(files.id, docs.fileId))
    .where(and(inArray(docs.id, ids), isNotNull(docs.snapshotKey), isNull(files.deletedAt)));
  return rows.map((r) => toRecord(r.id, r));
};

async function visibleFiles(load: Loader, ctx: EntityVisibilityContext, ids: string[]): Promise<Set<string>> {
  const records = await load(ctx.db, ids);
  const visible = new Set<string>();
  if (records.length === 0) return visible;
  const index = await loadDriveAccessForUser(ctx.db, ctx.actingUserId);
  const inProjects: FileRecord[] = [];
  for (const r of records) {
    if (!fileRole(index, r.file)) continue;
    // Drive says `editor` to anyone for a module's file; the project decides.
    if (r.projectId) inProjects.push(r);
    else visible.add(r.id);
  }
  if (inProjects.length > 0) {
    const projects = await projectEntityProvider.filterVisible(ctx, [...new Set(inProjects.map((r) => r.projectId!))]);
    for (const r of inProjects) if (projects.has(r.projectId!)) visible.add(r.id);
  }
  return visible;
}

function driveFileProvider(type: string, label: string, requiredPermission: string, load: Loader): EntityChannelProvider {
  const provider: EntityChannelProvider = {
    type,
    label,
    requiredPermission,

    async resolve({ db, entityId }) {
      const [record] = await load(db, [entityId]);
      if (!record) return null;
      const owner = record.file.uploadedById;
      return { displayName: record.name, defaultMemberIds: owner ? [owner] : [] };
    },

    async resolveDetail({ db, entityId }) {
      const [record] = await load(db, [entityId]);
      return record ? { id: record.id, name: record.name, fileId: record.file.id, projectId: record.projectId } : null;
    },

    filterVisible(ctx, entityIds) {
      return visibleFiles(load, ctx, entityIds);
    },

    canAccess(ctx) {
      return canAccessViaFilter(provider, ctx);
    },
  };
  return provider;
}

export const sheetEntityProvider = driveFileProvider('sheet', 'Sheets', 'sheets:read', loadSheets);
export const docEntityProvider = driveFileProvider('doc', 'Documents', 'docs:read', loadDocs);

registerEntityProvider(sheetEntityProvider);
registerEntityProvider(docEntityProvider);
