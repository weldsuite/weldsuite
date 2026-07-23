/**
 * Drive cross-module file aggregation — pure functions backing /api/drive/*.
 *
 * The "drive view" pulls files from 8 sources (drive, projects, documents,
 * whiteboards, mail, voip, meetings, social) and normalises them into a
 * single `UnifiedFile` shape so the frontend can render one feed.
 */

import { and, desc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { schema, type Database } from '../db';

const {
  files,
  folders,
  projectFiles,
  projectDocuments,
  projectWhiteboards,
  mailAttachments,
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
}

function buildNavigateUrl(
  entityType: string | null,
  entityId: string | null,
  metadata?: Record<string, unknown> | null,
  fileType?: string | null,
  fileId?: string | null,
): string | null {
  if (!entityType || !entityId) return null;
  switch (entityType) {
    case 'crm_contact': return `/weldcrm/contacts/${entityId}`;
    case 'crm_customer': return `/weldcrm/customers/${entityId}`;
    case 'project':
      // WeldFlow project sheets are stored as xlsx files. Clicking one in
      // WeldDrive should land back in the spreadsheet editor, not the
      // generic project files page.
      if (fileType === 'spreadsheet' && fileId) {
        return `/weldflow/project/${entityId}/table/${fileId}`;
      }
      return `/weldflow/project/${entityId}/files`;
    case 'project_document': {
      const projectId = metadata?.projectId as string | undefined;
      return projectId ? `/weldflow/project/${projectId}/documents` : null;
    }
    case 'helpdesk_ticket': return `/welddesk/tickets/${entityId}`;
    case 'mail_message': return `/weldmail/inbox/${entityId}`;
    case 'social_post': return `/weldcrm/social`;
    default: return null;
  }
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

export function normalizeGenericFiles(
  rows: (typeof schema.files.$inferSelect)[],
  r2PublicUrl?: string,
): UnifiedFile[] {
  const base = r2PublicUrl?.replace(/\/+$/, '');
  return rows.map((r) => ({
    id: r.id,
    name: r.fileName,
    fileType: r.fileType || 'file',
    mimeType: r.mimeType,
    fileSize: r.fileSize,
    url: r.url ?? (base && r.fileKey ? `${base}/${r.fileKey}` : null),
    thumbnailUrl: r.thumbnailUrl,
    source: 'drive',
    sourceLabel: 'My Drive',
    navigateTo: buildNavigateUrl(r.entityType, r.entityId, r.metadata, r.fileType, r.id),
    folderId: r.folderId,
    isStarred: r.isStarred,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt?.toISOString() ?? null,
    uploadedById: r.uploadedById,
    isWeldDoc: r.metadata?.welddoc === true,
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

function normalizeProjectDocuments(rows: (typeof schema.projectDocuments.$inferSelect)[]): UnifiedFile[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.title || 'Untitled Document',
    fileType: 'rich-document',
    mimeType: r.contentType === 'html' ? 'text/html' : r.contentType === 'markdown' ? 'text/markdown' : 'application/json',
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

function normalizeMailAttachments(rows: (typeof schema.mailAttachments.$inferSelect)[]): UnifiedFile[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.fileName || 'Attachment',
    fileType: guessFileType(r.contentType, r.fileName),
    mimeType: r.contentType,
    fileSize: r.size,
    url: r.downloadUrl,
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
// /all aggregator
// ============================================================================

export async function aggregateAllFiles(
  db: Database,
  params: { source?: string; r2PublicUrl?: string },
): Promise<UnifiedFile[]> {
  const shouldQuery = (s: string) => !params.source || params.source === s;

  const [
    genericFiles,
    projectFilesRes,
    projectDocsRes,
    whiteboardsRes,
    mailAttachmentsRes,
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
      ? db.select().from(mailAttachments).where(isNull(mailAttachments.deletedAt))
      : Promise.resolve([] as (typeof schema.mailAttachments.$inferSelect)[]),
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
    ...normalizeGenericFiles(genericFiles, params.r2PublicUrl),
    ...normalizeProjectFiles(projectFilesRes),
    ...normalizeProjectDocuments(projectDocsRes),
    ...normalizeProjectWhiteboards(whiteboardsRes),
    ...normalizeMailAttachments(mailAttachmentsRes),
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

export function queryArray<T>(items: T[], options: QueryOptions<T>): PaginatedResult<T> {
  let result = [...items];

  if (options.search && options.searchFields) {
    const term = options.search.toLowerCase().trim();
    if (term) {
      result = result.filter((item) =>
        options.searchFields!.some((field) => {
          const value = (item as Record<string, unknown>)[field as string];
          if (value == null) return false;
          return String(value).toLowerCase().includes(term);
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
    result = [...result].sort((a, b) => {
      const av = (a as Record<string, unknown>)[sortBy];
      const bv = (b as Record<string, unknown>)[sortBy];
      if (av == null && bv == null) return 0;
      if (av == null) return order === 'asc' ? 1 : -1;
      if (bv == null) return order === 'asc' ? -1 : 1;
      if (typeof av === 'string' && typeof bv === 'string') {
        const cmp = av.localeCompare(bv);
        return order === 'asc' ? cmp : -cmp;
      }
      if (typeof av === 'number' && typeof bv === 'number') {
        return order === 'asc' ? av - bv : bv - av;
      }
      return 0;
    });
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

export async function aggregateStats(db: Database): Promise<DriveStats> {
  const [
    genericCount,
    projectFilesCount,
    projectDocsCount,
    whiteboardsCount,
    mailAttachmentsCount,
    voipCount,
    meetingsCount,
    socialCount,
    recentGenericCount,
  ] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(files).where(isNull(files.deletedAt)),
    db.select({ count: sql<number>`count(*)::int` }).from(projectFiles).where(and(isNull(projectFiles.deletedAt), eq(projectFiles.isFolder, false))),
    db.select({ count: sql<number>`count(*)::int` }).from(projectDocuments).where(isNull(projectDocuments.deletedAt)),
    db.select({ count: sql<number>`count(*)::int` }).from(projectWhiteboards).where(isNull(projectWhiteboards.deletedAt)),
    db.select({ count: sql<number>`count(*)::int` }).from(mailAttachments).where(isNull(mailAttachments.deletedAt)),
    db.select({ count: sql<number>`count(*)::int` }).from(voipCalls).where(eq(voipCalls.isRecorded, true)),
    db.select({ count: sql<number>`count(*)::int` }).from(meetingBotSessions).where(isNotNull(meetingBotSessions.recordingStorageUrl)),
    db.select({ count: sql<number>`count(*)::int` }).from(socialMedia).where(ne(socialMedia.status, 'deleted')),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(files)
      .where(and(isNull(files.deletedAt), sql`${files.createdAt} > now() - interval '7 days'`)),
  ]);

  const drive = Number(genericCount[0]?.count || 0);
  const projects = Number(projectFilesCount[0]?.count || 0);
  const documents = Number(projectDocsCount[0]?.count || 0);
  const whiteboards = Number(whiteboardsCount[0]?.count || 0);
  const mail = Number(mailAttachmentsCount[0]?.count || 0);
  const voip = Number(voipCount[0]?.count || 0);
  const meetings = Number(meetingsCount[0]?.count || 0);
  const social = Number(socialCount[0]?.count || 0);
  return {
    totalFiles: drive + projects + documents + whiteboards + mail + voip + meetings + social,
    recentCount: Number(recentGenericCount[0]?.count || 0),
    bySource: { drive, projects, documents, whiteboards, mail, voip, meetings, social },
  };
}

// ============================================================================
// Trash helpers (cross-table — files + folders)
// ============================================================================

export async function listAllTrashedFileKeysForR2(db: Database): Promise<string[]> {
  const rows = await db
    .select({ fileKey: files.fileKey, storagePath: files.storagePath })
    .from(files)
    .where(isNotNull(files.deletedAt));
  return rows.map((f) => f.fileKey || f.storagePath).filter(Boolean) as string[];
}

export async function emptyTrash(db: Database): Promise<void> {
  await Promise.all([
    db.delete(files).where(isNotNull(files.deletedAt)),
    db.delete(folders).where(isNotNull(folders.deletedAt)),
  ]);
}
