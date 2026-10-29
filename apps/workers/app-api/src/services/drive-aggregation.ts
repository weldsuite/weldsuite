/**
 * Drive cross-module file aggregation — pure functions backing /api/drive/*.
 *
 * The "drive view" pulls files from 8 sources (drive, projects, documents,
 * whiteboards, mail, voip, meetings, social) and normalises them into a
 * single `UnifiedFile` shape so the frontend can render one feed.
 *
 * Two sources have per-record access, and the feed and its counters only
 * include what the caller may open:
 *   - drive files follow the WeldDrive sharing rules
 *     (`@weldsuite/core-domain/drive-access`);
 *   - mail attachments come from mailboxes the caller is assigned to
 *     (`@weldsuite/mail-domain/access`).
 */

import { and, eq, getTableColumns, inArray, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { isAdminOrOwner, userAccessCondition } from '@weldsuite/mail-domain/access';
import type { WorkspaceMail } from '@weldsuite/mail-domain/store';
import { asText } from '@weldsuite/text';
import { fileDescription, listDocumentSnapshotKeys } from '@weldsuite/core-domain/files';
import {
  isWorkspaceAdmin,
  loadDriveAccess,
  withFileAccess,
  type DriveAccessFields,
  type DriveAccessIndex,
} from '@weldsuite/core-domain/drive-access';
import { buildResultUrl } from './search';
import { privateObjectUrl } from '@weldsuite/worker-kit/storage';

const {
  files,
  folders,
  projectFiles,
  projectDocuments,
  projectWhiteboards,
  mailAttachments,
  mailMessages,
  mailAccounts,
  voipCalls,
  meetingBotSessions,
  socialMedia,
} = schema;

// ============================================================================
// Unified shape
// ============================================================================

export interface UnifiedFile {
  id: string;
  name: string;
  fileType: string;
  mimeType: string | null;
  fileSize: number | null;
  url: string | null;
  thumbnailUrl: string | null;
  source: string;
  sourceLabel: string;
  navigateTo: string | null;
  folderId: string | null;
  isStarred: boolean;
  createdAt: string;
  updatedAt: string | null;
  uploadedById: string | null;
  /** True when this drive file is a native WeldDoc (opens in the documents editor). */
  isWeldDoc?: boolean;
  /** Drive files only: the record the file belongs to (e.g. `project`), null for plain uploads. */
  entityType?: string | null;
  /** Drive files only: the Details panel description (HTML). */
  description?: string | null;
  /** Drive files only: the caller's role on the file. */
  accessRole?: DriveAccessFields['accessRole'];
  /** Drive files only: the general access in force, counting the folders above the file. */
  effectiveAccess?: DriveAccessFields['effectiveAccess'];
}

/** Drive files a module stores for one of its records (WeldFlow sheets and documents). */
const PROJECT_ENTITY_TYPES = new Set(['project', 'project_document']);

function buildNavigateUrl(
  entityType: string | null,
  entityId: string | null,
  metadata?: Record<string, unknown> | null,
  fileType?: string | null,
  fileId?: string | null,
): string | null {
  if (!entityType || !entityId) return null;
  switch (entityType) {
    // People and companies open as object panels on their list page.
    case 'crm_contact': return buildResultUrl('contact', entityId);
    case 'crm_customer': return buildResultUrl('customer', entityId);
    case 'project':
      // A WeldFlow project sheet opens in its project (where an .xlsx one
      // saved by the old project grid becomes a WeldSheets spreadsheet on
      // first open), not on the generic project files page.
      if (fileType === 'spreadsheet' && fileId) {
        return `/weldflow/project/${entityId}/table/${fileId}`;
      }
      return `/weldflow/project/${entityId}/files`;
    case 'project_document': {
      const projectId = metadata?.projectId as string | undefined;
      return projectId ? `/weldflow/project/${projectId}/documents` : null;
    }
    case 'helpdesk_ticket': return buildResultUrl('ticket', entityId);
    // The unified view resolves a message by id alone, so the link needs no
    // account id.
    case 'mail_message': return `/weldmail/unified/inbox/${entityId}`;
    // WeldSocial has no per-post route; posts open from its own pages.
    case 'social_post': return '/social';
    default: return null;
  }
}

/**
 * A WeldSheets spreadsheet or WeldDocs document (a drive file whose metadata
 * names its sheet or document) opens in its editor. A WeldDocs document is not
 * `isWeldDoc` (that flag is the BlockNote editor's, at `/documents/:fileId`).
 */
function weldModuleUrl(metadata: Record<string, unknown> | null | undefined): string | null {
  const sheetId = metadata?.weldsheetId;
  if (typeof sheetId === 'string') return `/weldsheets/${sheetId}`;
  const docId = metadata?.weldDocId;
  return typeof docId === 'string' ? `/welddocs/${docId}` : null;
}

function guessFileType(mimeType: string | null, fileName: string | null): string {
  if (!mimeType) return 'file';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType.includes('csv')) return 'spreadsheet';
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return 'presentation';
  if (mimeType.includes('document') || mimeType.includes('word') || mimeType.includes('text/')) return 'document';
  if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('tar') || mimeType.includes('gzip')) return 'archive';
  const ext = fileName?.split('.').pop()?.toLowerCase();
  if (ext && ['js', 'ts', 'py', 'go', 'rs', 'java', 'cpp', 'c', 'h', 'css', 'html', 'json', 'xml', 'yaml', 'yml', 'sh', 'sql'].includes(ext)) return 'code';
  return 'file';
}

// ============================================================================
// Normalizers
// ============================================================================

/** URL for a row that stores only its key: private bucket via app-api, else the public domain. */
function storedUrl(
  r: { fileKey: string | null; bucket: string | null },
  publicBase: string | undefined,
  apiOrigin: string | undefined,
): string | null {
  if (!r.fileKey) return null;
  if (r.bucket === 'private') return apiOrigin ? privateObjectUrl(apiOrigin, r.fileKey) : null;
  return publicBase ? `${publicBase}/${r.fileKey}` : null;
}

export function normalizeGenericFiles(
  rows: ((typeof schema.files.$inferSelect) & Partial<DriveAccessFields>)[],
  r2PublicUrl?: string,
  /** app-api origin, for rows in the private bucket that store no `url`. */
  apiOrigin?: string,
): UnifiedFile[] {
  const base = r2PublicUrl?.replace(/(?<!\/)\/+$/, '');
  return rows.map((r) => ({
    id: r.id,
    name: r.fileName,
    fileType: r.fileType || 'file',
    mimeType: r.mimeType,
    fileSize: r.fileSize,
    url: r.url ?? storedUrl(r, base, apiOrigin),
    thumbnailUrl: r.thumbnailUrl,
    // Still `drive` (it lives in the files table and supports every Drive
    // action), but a WeldFlow sheet or document is labelled as the project's.
    source: 'drive',
    sourceLabel: r.entityType && PROJECT_ENTITY_TYPES.has(r.entityType) ? 'Projects' : 'My Drive',
    navigateTo: buildNavigateUrl(r.entityType, r.entityId, r.metadata, r.fileType, r.id) ?? weldModuleUrl(r.metadata),
    folderId: r.folderId,
    isStarred: r.isStarred,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt?.toISOString() ?? null,
    uploadedById: r.uploadedById,
    isWeldDoc: r.metadata?.welddoc === true,
    entityType: r.entityType,
    description: fileDescription(r),
    accessRole: r.accessRole,
    effectiveAccess: r.effectiveAccess,
  }));
}

function normalizeProjectFiles(rows: (typeof schema.projectFiles.$inferSelect)[]): UnifiedFile[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.fileName,
    fileType: r.fileType || 'file',
    mimeType: r.mimeType,
    fileSize: r.fileSize,
    url: r.url,
    thumbnailUrl: r.thumbnailUrl,
    source: 'projects',
    sourceLabel: 'Projects',
    navigateTo: r.projectId ? `/weldflow/project/${r.projectId}/files` : null,
    folderId: null,
    isStarred: false,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt?.toISOString() ?? null,
    uploadedById: r.uploadedById,
  }));
}

function projectDocumentMimeType(contentType: string): string {
  if (contentType === 'html') return 'text/html';
  if (contentType === 'markdown') return 'text/markdown';
  return 'application/json';
}

function normalizeProjectDocuments(rows: (typeof schema.projectDocuments.$inferSelect)[]): UnifiedFile[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.title || 'Untitled Document',
    fileType: 'rich-document',
    mimeType: projectDocumentMimeType(r.contentType),
    fileSize: null,
    url: null,
    thumbnailUrl: r.coverImage || null,
    source: 'documents',
    sourceLabel: 'Documents',
    navigateTo: r.projectId ? `/weldflow/project/${r.projectId}/documents` : null,
    folderId: null,
    isStarred: false,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt?.toISOString() ?? null,
    uploadedById: null,
  }));
}

function normalizeProjectWhiteboards(rows: (typeof schema.projectWhiteboards.$inferSelect)[]): UnifiedFile[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.name || 'Untitled Whiteboard',
    fileType: 'whiteboard',
    mimeType: null,
    fileSize: null,
    url: null,
    thumbnailUrl: null,
    source: 'whiteboards',
    sourceLabel: 'Whiteboards',
    navigateTo: r.projectId ? `/weldflow/project/${r.projectId}/whiteboard/${r.id}` : null,
    folderId: null,
    isStarred: false,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt?.toISOString() ?? null,
    uploadedById: null,
  }));
}

/**
 * A mail attachment's `downloadUrl` is a bare object-storage URL with no
 * session, signature or expiry — mail-api's own routes never return it for
 * exactly that reason (`toPublicAttachment`), serving bytes only from
 * `GET /api/mail-attachments/:id/download`, which re-checks the mailbox
 * before streaming. This view must not hand out the bypass URL just because
 * it reached the row through a join; point at the authenticated route
 * instead, like `storedUrl` does for Drive's own private files. `undefined`
 * `apiOrigin` (no request context, e.g. a future batch job) means no URL
 * rather than the raw one.
 */
/**
 * Trailing `/`s stripped, without a `/+$/`-style regex: unanchored at the
 * start, that pattern's backtracking is O(n²) on an adversarial input (a long
 * run of `/` immediately followed by a non-`/` character) — a linear scan
 * from the end is simpler and can't have that problem.
 */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* '/' */) end -= 1;
  return value.slice(0, end);
}

function mailAttachmentDownloadUrl(id: string, apiOrigin: string | undefined): string | null {
  if (!apiOrigin) return null;
  return `${stripTrailingSlashes(apiOrigin)}/api/mail-attachments/${encodeURIComponent(id)}/download`;
}

function normalizeMailAttachments(
  rows: (typeof schema.mailAttachments.$inferSelect)[],
  apiOrigin: string | undefined,
): UnifiedFile[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.fileName || 'Attachment',
    fileType: guessFileType(r.contentType, r.fileName),
    mimeType: r.contentType,
    fileSize: r.size,
    url: mailAttachmentDownloadUrl(r.id, apiOrigin),
    thumbnailUrl: null,
    source: 'mail',
    sourceLabel: 'Mail',
    navigateTo: null,
    folderId: null,
    isStarred: false,
    createdAt: r.createdAt.toISOString(),
    updatedAt: null,
    uploadedById: null,
  }));
}

function normalizeVoipRecordings(rows: (typeof schema.voipCalls.$inferSelect)[]): UnifiedFile[] {
  return rows.map((r) => ({
    id: r.id,
    name: `Call Recording ${r.direction === 'inbound' ? 'Inbound' : 'Outbound'} - ${r.createdAt.toLocaleDateString()}`,
    fileType: 'recording',
    mimeType: 'audio/mpeg',
    fileSize: r.recordingFileSize,
    url: r.recordingStorageUrl,
    thumbnailUrl: null,
    source: 'voip',
    sourceLabel: 'Call Intelligence',
    navigateTo: '/weldcrm/call-intelligence',
    folderId: null,
    isStarred: false,
    createdAt: r.createdAt.toISOString(),
    updatedAt: null,
    uploadedById: null,
  }));
}

function normalizeMeetingRecordings(rows: (typeof schema.meetingBotSessions.$inferSelect)[]): UnifiedFile[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.title || `Meeting Recording - ${r.createdAt.toLocaleDateString()}`,
    fileType: 'recording',
    mimeType: 'video/mp4',
    fileSize: r.recordingFileSize,
    url: r.recordingStorageUrl,
    thumbnailUrl: null,
    source: 'meetings',
    sourceLabel: 'Meeting Intelligence',
    navigateTo: '/weldcrm/calls',
    folderId: null,
    isStarred: false,
    createdAt: r.createdAt.toISOString(),
    updatedAt: null,
    uploadedById: null,
  }));
}

function normalizeSocialMedia(rows: (typeof schema.socialMedia.$inferSelect)[]): UnifiedFile[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.fileName || `Social Media ${r.mediaType}`,
    fileType: r.mediaType === 'gif' ? 'image' : r.mediaType || 'file',
    mimeType: r.mimeType,
    fileSize: r.fileSize,
    url: r.url,
    thumbnailUrl: r.thumbnailUrl,
    source: 'social',
    sourceLabel: 'Social',
    navigateTo: null,
    folderId: null,
    isStarred: false,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt?.toISOString() ?? null,
    uploadedById: null,
  }));
}

// ============================================================================
// Mail attachment access
// ============================================================================

/**
 * WHERE clause for the mail attachments `userId` may see: live attachments
 * whose mailbox they may open. It refers to `mailAccounts`, so the query has
 * to join attachment → message → account.
 */
async function accessibleMailAttachments(db: Database, userId: string): Promise<SQL> {
  const admin = await isAdminOrOwner(db, userId);
  return and(
    isNull(mailAttachments.deletedAt),
    isNull(mailAccounts.deletedAt),
    userAccessCondition(userId, admin),
  )!;
}

/**
 * Object modes have no "every row, unbounded" read — only a capped
 * `recentAttachments` (design §5's own suggested per-mailbox cap). `/all`
 * merges every drive source in memory and paginates client-side, so this
 * caps how many of the most recent mail attachments feed that merge in
 * object modes; `postgres` mode is unaffected (still the full, unbounded
 * join below).
 */
const DRIVE_MAIL_ATTACHMENTS_LIMIT = 2000;

/**
 * `/api/drive/all`'s mail attachments, through the mailbox store in
 * `shadow`/`object`/`object-only` mode (docs/plans/weldmail-mailbox-store-
 * design.md §5: "Drive: `recentAttachments(accountIds, {limit: 2000 per
 * mailbox})` + Σ `totalCount`, merged by `createdAt`"), keeping today's join
 * query verbatim in `postgres` mode (and when no `mail` was resolved at all —
 * every existing caller of `aggregateAllFiles`, which predates the store).
 * Same access scoping either way: `MailAccess.accessibleAccountIds()` in
 * object modes is the mailbox-access rule this file's own
 * `accessibleMailAttachments` enforces in postgres mode, just read from the
 * KV directory instead of a live query.
 */
async function loadMailAttachmentsForAll(
  db: Database,
  params: { userId: string; apiOrigin?: string; mail?: WorkspaceMail },
): Promise<UnifiedFile[]> {
  if (!params.mail || params.mail.mode === 'postgres') {
    const where = await accessibleMailAttachments(db, params.userId);
    const rows = await db
      .select(getTableColumns(mailAttachments))
      .from(mailAttachments)
      .innerJoin(mailMessages, eq(mailMessages.id, mailAttachments.messageId))
      .innerJoin(mailAccounts, eq(mailAccounts.id, mailMessages.accountId))
      .where(where);
    return normalizeMailAttachments(rows, params.apiOrigin);
  }

  const accountIds = await params.mail.access.accessibleAccountIds();
  if (accountIds.length === 0) return [];
  const { data } = await params.mail.store.recentAttachments(accountIds, { limit: DRIVE_MAIL_ATTACHMENTS_LIMIT });
  return normalizeMailAttachments(data, params.apiOrigin);
}

/**
 * `/api/drive/stats`'s mail counter, same routing as
 * {@link loadMailAttachmentsForAll}. `recentAttachments`'s `totalCount` is the
 * real count regardless of `limit` in both store backends (`store/types.ts`'s
 * own contract), so this asks for the smallest page that still gives one.
 */
async function countMailAttachments(db: Database, userId: string, mail?: WorkspaceMail): Promise<number> {
  if (!mail || mail.mode === 'postgres') {
    const where = await accessibleMailAttachments(db, userId);
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(mailAttachments)
      .innerJoin(mailMessages, eq(mailMessages.id, mailAttachments.messageId))
      .innerJoin(mailAccounts, eq(mailAccounts.id, mailMessages.accountId))
      .where(where);
    return Number(row?.count ?? 0);
  }

  const accountIds = await mail.access.accessibleAccountIds();
  if (accountIds.length === 0) return 0;
  const { totalCount } = await mail.store.recentAttachments(accountIds, { limit: 1 });
  return totalCount;
}

// ============================================================================
// Drive file access
// ============================================================================

/** The Drive sharing rules for `userId`, unless the route already loaded them. */
async function driveAccessFor(db: Database, userId: string, loaded?: DriveAccessIndex): Promise<DriveAccessIndex> {
  return loaded ?? loadDriveAccess(db, { userId, isAdmin: await isWorkspaceAdmin(db, userId) });
}

// ============================================================================
// /all aggregator
// ============================================================================

export async function aggregateAllFiles(
  db: Database,
  params: {
    userId: string;
    source?: string;
    r2PublicUrl?: string;
    apiOrigin?: string;
    driveAccess?: DriveAccessIndex;
    /** Resolved once by the route (`routes/drive/index.ts`); omitted ⇒ the postgres-mode mail query, unchanged. */
    mail?: WorkspaceMail;
  },
): Promise<UnifiedFile[]> {
  const shouldQuery = (s: string) => !params.source || params.source === s;
  const driveAccess = shouldQuery('drive') ? await driveAccessFor(db, params.userId, params.driveAccess) : null;

  const [
    genericFiles,
    projectFilesRes,
    projectDocsRes,
    whiteboardsRes,
    mailFiles,
    voipCallsRes,
    meetingsRes,
    socialMediaRes,
  ] = await Promise.all([
    shouldQuery('drive')
      ? db.select().from(files).where(isNull(files.deletedAt))
      : Promise.resolve([] as (typeof schema.files.$inferSelect)[]),
    shouldQuery('projects')
      ? db.select().from(projectFiles).where(and(isNull(projectFiles.deletedAt), eq(projectFiles.isFolder, false)))
      : Promise.resolve([] as (typeof schema.projectFiles.$inferSelect)[]),
    shouldQuery('documents')
      ? db.select().from(projectDocuments).where(isNull(projectDocuments.deletedAt))
      : Promise.resolve([] as (typeof schema.projectDocuments.$inferSelect)[]),
    shouldQuery('whiteboards')
      ? db.select().from(projectWhiteboards).where(isNull(projectWhiteboards.deletedAt))
      : Promise.resolve([] as (typeof schema.projectWhiteboards.$inferSelect)[]),
    shouldQuery('mail')
      ? loadMailAttachmentsForAll(db, { userId: params.userId, apiOrigin: params.apiOrigin, mail: params.mail })
      : Promise.resolve([] as UnifiedFile[]),
    shouldQuery('voip')
      ? db.select().from(voipCalls).where(eq(voipCalls.isRecorded, true))
      : Promise.resolve([] as (typeof schema.voipCalls.$inferSelect)[]),
    shouldQuery('meetings')
      ? db.select().from(meetingBotSessions).where(isNotNull(meetingBotSessions.recordingStorageUrl))
      : Promise.resolve([] as (typeof schema.meetingBotSessions.$inferSelect)[]),
    shouldQuery('social')
      ? db.select().from(socialMedia).where(ne(socialMedia.status, 'deleted'))
      : Promise.resolve([] as (typeof schema.socialMedia.$inferSelect)[]),
  ]);

  return [
    ...normalizeGenericFiles(
      driveAccess ? withFileAccess(driveAccess, genericFiles) : [],
      params.r2PublicUrl,
      params.apiOrigin,
    ),
    ...normalizeProjectFiles(projectFilesRes),
    ...normalizeProjectDocuments(projectDocsRes),
    ...normalizeProjectWhiteboards(whiteboardsRes),
    ...mailFiles,
    ...normalizeVoipRecordings(voipCallsRes),
    ...normalizeMeetingRecordings(meetingsRes),
    ...normalizeSocialMedia(socialMediaRes),
  ];
}

// ============================================================================
// In-memory pagination / sort / filter (ported from api-worker/lib/pagination)
// ============================================================================

export interface QueryOptions<T> {
  page?: number;
  pageSize?: number;
  search?: string;
  searchFields?: (keyof T | string)[];
  sortBy?: keyof T | string;
  sortOrder?: 'asc' | 'desc';
  filters?: Partial<Record<keyof T | string, unknown>>;
}

export interface PaginatedResult<T> {
  items: T[];
  pagination: {
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
    hasMore: boolean;
  };
}

/** Compare two sort values; nulls sort last (asc) / first (desc), mixed types compare equal. */
function compareSortValues(av: unknown, bv: unknown, order: 'asc' | 'desc'): number {
  const dir = order === 'asc' ? 1 : -1;
  if (av == null && bv == null) return 0;
  if (av == null) return dir;
  if (bv == null) return -dir;
  if (typeof av === 'string' && typeof bv === 'string') return dir * av.localeCompare(bv);
  if (typeof av === 'number' && typeof bv === 'number') return dir * (av - bv);
  return 0;
}

export function queryArray<T>(items: T[], options: QueryOptions<T>): PaginatedResult<T> {
  let result = [...items];

  if (options.search && options.searchFields) {
    const term = options.search.toLowerCase().trim();
    if (term) {
      result = result.filter((item) =>
        options.searchFields!.some((field) => {
          const value = (item as Record<string, unknown>)[field as string];
          if (value == null) return false;
          return asText(value).toLowerCase().includes(term);
        }),
      );
    }
  }

  if (options.filters) {
    for (const [field, value] of Object.entries(options.filters)) {
      if (value !== undefined && value !== null && value !== '') {
        result = result.filter((item) => (item as Record<string, unknown>)[field] === value);
      }
    }
  }

  if (options.sortBy) {
    const sortBy = options.sortBy as string;
    const order = options.sortOrder ?? 'asc';
    result = [...result].sort((a, b) =>
      compareSortValues(
        (a as Record<string, unknown>)[sortBy],
        (b as Record<string, unknown>)[sortBy],
        order,
      ),
    );
  }

  const page = options.page ?? 1;
  const pageSize = options.pageSize ?? 30;
  const totalCount = result.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const offset = (page - 1) * pageSize;
  const pageItems = result.slice(offset, offset + pageSize);
  return {
    items: pageItems,
    pagination: { page, pageSize, totalCount, totalPages, hasMore: page < totalPages },
  };
}

// ============================================================================
// /stats aggregator
// ============================================================================

export interface DriveStats {
  totalFiles: number;
  recentCount: number;
  bySource: Record<string, number>;
}

export async function aggregateStats(
  db: Database,
  userId: string,
  loadedDriveAccess?: DriveAccessIndex,
  /** Resolved once by the route (`routes/drive/index.ts`); omitted ⇒ the postgres-mode mail count, unchanged. */
  mail?: WorkspaceMail,
): Promise<DriveStats> {
  const [mailAttachmentsCount, driveAccess] = await Promise.all([
    countMailAttachments(db, userId, mail),
    driveAccessFor(db, userId, loadedDriveAccess),
  ]);
  const [
    driveRows,
    projectFilesCount,
    projectDocsCount,
    whiteboardsCount,
    voipCount,
    meetingsCount,
    socialCount,
  ] = await Promise.all([
    // Drive files are counted after the sharing rules, so only the columns they read.
    db
      .select({
        id: files.id,
        uploadedById: files.uploadedById,
        folderId: files.folderId,
        generalAccess: files.generalAccess,
        entityType: files.entityType,
        createdAt: files.createdAt,
      })
      .from(files)
      .where(isNull(files.deletedAt)),
    db.select({ count: sql<number>`count(*)::int` }).from(projectFiles).where(and(isNull(projectFiles.deletedAt), eq(projectFiles.isFolder, false))),
    db.select({ count: sql<number>`count(*)::int` }).from(projectDocuments).where(isNull(projectDocuments.deletedAt)),
    db.select({ count: sql<number>`count(*)::int` }).from(projectWhiteboards).where(isNull(projectWhiteboards.deletedAt)),
    db.select({ count: sql<number>`count(*)::int` }).from(voipCalls).where(eq(voipCalls.isRecorded, true)),
    db.select({ count: sql<number>`count(*)::int` }).from(meetingBotSessions).where(isNotNull(meetingBotSessions.recordingStorageUrl)),
    db.select({ count: sql<number>`count(*)::int` }).from(socialMedia).where(ne(socialMedia.status, 'deleted')),
  ]);

  const visibleDrive = withFileAccess(driveAccess, driveRows);
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const drive = visibleDrive.length;
  const projects = Number(projectFilesCount[0]?.count || 0);
  const documents = Number(projectDocsCount[0]?.count || 0);
  const whiteboards = Number(whiteboardsCount[0]?.count || 0);
  const voip = Number(voipCount[0]?.count || 0);
  const meetings = Number(meetingsCount[0]?.count || 0);
  const social = Number(socialCount[0]?.count || 0);
  return {
    totalFiles: drive + projects + documents + whiteboards + mailAttachmentsCount + voip + meetings + social,
    recentCount: visibleDrive.filter((f) => f.createdAt.getTime() > weekAgo).length,
    bySource: { drive, projects, documents, whiteboards, mail: mailAttachmentsCount, voip, meetings, social },
  };
}

// ============================================================================
// Trash helpers (cross-table — files + folders)
// ============================================================================

export interface TrashedIds {
  fileIds: string[];
  folderIds: string[];
}

/** The rows `purgeTrashed` removes: the trashed files, and every file in a trashed folder. */
function purgedFilesWhere(ids: TrashedIds): SQL | undefined {
  const conditions: SQL[] = [];
  if (ids.fileIds.length > 0) conditions.push(and(inArray(files.id, ids.fileIds), isNotNull(files.deletedAt))!);
  if (ids.folderIds.length > 0) conditions.push(inArray(files.folderId, ids.folderIds));
  return conditions.length > 0 ? or(...conditions) : undefined;
}

/**
 * The R2 keys of what `purgeTrashed` removes, so the route deletes the objects
 * first: the files themselves, and the checkpoint and version snapshots of the
 * spreadsheets and documents among them.
 */
export async function listPurgedFileKeys(db: Database, ids: TrashedIds): Promise<string[]> {
  const where = purgedFilesWhere(ids);
  if (!where) return [];
  const rows = await db.select({ fileKey: files.fileKey, storagePath: files.storagePath }).from(files).where(where);
  const fileKeys = rows.map((f) => f.fileKey || f.storagePath).filter(Boolean) as string[];
  const snapshotKeys = await listDocumentSnapshotKeys(db, db.select({ id: files.id }).from(files).where(where));
  return [...fileKeys, ...snapshotKeys];
}

/**
 * Permanently delete trashed files and folders. A folder goes with the files
 * in it, as `purgeFolder` does. The caller has already narrowed the ids to
 * what it may change.
 */
export async function purgeTrashed(db: Database, ids: TrashedIds): Promise<void> {
  const where = purgedFilesWhere(ids);
  if (where) {
    // A WeldSheets spreadsheet's or WeldDocs document's row references its file; files reference their folder.
    const purged = db.select({ id: files.id }).from(files).where(where);
    await db.delete(schema.sheets).where(inArray(schema.sheets.fileId, purged));
    await db.delete(schema.documentVersions).where(inArray(schema.documentVersions.fileId, purged));
    await db.delete(schema.docs).where(inArray(schema.docs.fileId, purged));
    await db.delete(files).where(where);
  }
  if (ids.folderIds.length > 0) {
    await db.delete(folders).where(and(inArray(folders.id, ids.folderIds), isNotNull(folders.deletedAt)));
  }
}
