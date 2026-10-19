/**
 * Files schemas (Zod v3) — powers /api/files/*.
 *
 * Single source of truth for the drive-native file store (`files` table).
 * Types lifted from the legacy `apps/web/platform/lib/api/domains/welddrive.ts`.
 */

import { z } from 'zod';
import { driveGeneralAccessSchema, type DriveAccessRole, type DriveGeneralAccess } from './drive-shares';

// ============================================================================
// Shared enums
// ============================================================================

export type DriveFileType =
  | 'image' | 'video' | 'audio' | 'pdf'
  | 'document' | 'spreadsheet' | 'presentation'
  | 'archive' | 'code' | 'file'
  | 'recording' | 'whiteboard' | 'rich-document';

export type DriveSource =
  | 'drive' | 'projects' | 'documents' | 'whiteboards'
  | 'mail' | 'voip' | 'meetings' | 'social';

// ============================================================================
// Names
// ============================================================================

/**
 * Characters a Drive file or folder name may not contain: the path separators
 * and the characters Windows and macOS reserve. A "/" breaks path-style
 * display and breadcrumbs, and the others get a download renamed or refused.
 */
const RESERVED_NAME_CHARS = /[/\\:*?"<>|]/;
const RESERVED_NAME_CHARS_GLOBAL = /[/\\:*?"<>|]/g;

function hasControlChars(name: string): boolean {
  for (const ch of name) {
    if (ch.charCodeAt(0) < 32) return true;
  }
  return false;
}

/** The characters `isValidDriveName` rejects, for showing in an error. */
export const RESERVED_DRIVE_NAME_CHARS = '/ \\ : * ? " < > |';

/** True when `name` (already trimmed) is usable as a Drive file or folder name. */
export function isValidDriveName(name: string): boolean {
  if (!name || name === '.' || name === '..') return false;
  return !RESERVED_NAME_CHARS.test(name) && !hasControlChars(name);
}

/**
 * Make an incoming name (an uploaded file's own name) usable: reserved and
 * control characters become "_", surrounding whitespace goes.
 */
export function sanitizeDriveName(name: string): string {
  let out = '';
  for (const ch of name.replace(RESERVED_NAME_CHARS_GLOBAL, '_')) {
    out += ch.charCodeAt(0) < 32 ? '_' : ch;
  }
  out = out.trim();
  return out === '' || out === '.' || out === '..' ? 'untitled' : out;
}

/** A name typed by a person (rename, new folder): trimmed, reserved characters rejected. */
export const driveNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(isValidDriveName, {
    message: `A name can't contain ${RESERVED_DRIVE_NAME_CHARS}`,
  });

// ============================================================================
// Inputs
// ============================================================================

export const listFilesQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
  search: z.string().optional(),
  type: z.string().optional(),
  source: z.string().optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  folderId: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  // Filter to files attached to a specific CRM/other record (e.g. a WeldCRM
  // company or person panel's Files tab), via the `files.entityType` +
  // `files.entityId` columns. Both must be set together.
  entityType: z.string().optional(),
  entityId: z.string().optional(),
});

export const createFileSchema = z.object({
  // Uploads keep their own name, made usable rather than refused.
  fileName: z.string().trim().min(1).max(500).transform(sanitizeDriveName),
  originalName: z.string().optional(),
  mimeType: z.string().min(1),
  fileSize: z.number().int().min(0),
  fileType: z.string().optional().default('file'),
  storagePath: z.string().min(1),
  fileKey: z.string().optional(),
  bucket: z.string().optional(),
  url: z.string().optional(),
  thumbnailUrl: z.string().optional(),
  folderId: z.string().nullish(),
  isPublic: z.boolean().optional(),
  entityType: z.string().optional(),
  entityId: z.string().nullish(),
  metadata: z.record(z.unknown()).optional(),
});

export const updateFileSchema = z.object({
  fileName: driveNameSchema.optional(),
  folderId: z.string().nullable().optional(),
  isStarred: z.boolean().optional(),
  isPublic: z.boolean().optional(),
});

/**
 * WeldDrive's own PATCH /api/files/:id (app-api): the shared fields plus the
 * description shown in the Details panel, kept in `files.metadata`, and who
 * besides the people it is shared with may open the file.
 */
export const updateDriveFileSchema = updateFileSchema.extend({
  description: z.string().max(20000).nullable().optional(),
  generalAccess: driveGeneralAccessSchema.optional(),
});

export const moveFileSchema = z.object({
  folderId: z.string().nullable(),
});

export type ListFilesQuery = z.input<typeof listFilesQuery>;
export type CreateFileInput = z.infer<typeof createFileSchema>;
export type UpdateFileInput = z.infer<typeof updateFileSchema>;
export type UpdateDriveFileInput = z.infer<typeof updateDriveFileSchema>;
export type MoveFileInput = z.infer<typeof moveFileSchema>;

// ============================================================================
// Response shapes
// ============================================================================

export interface DriveFile {
  id: string;
  fileName: string;
  originalName: string | null;
  mimeType: string;
  fileSize: number;
  fileType: string;
  storagePath: string;
  fileKey: string | null;
  bucket: string | null;
  url: string | null;
  thumbnailUrl: string | null;
  storageProvider: string;
  folderId: string | null;
  uploadedById: string | null;
  isPublic: boolean;
  isStarred: boolean;
  generalAccess: DriveGeneralAccess;
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  /** The caller's role on the file (app-api reads only). */
  accessRole?: DriveAccessRole;
  /** The general access in force, counting the folders above the file (app-api reads only). */
  effectiveAccess?: DriveGeneralAccess;
}

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
  deletedAt?: string | null;
  /** True when this drive file is a native WeldDoc (opens in the documents editor). */
  isWeldDoc?: boolean;
  /** Drive files only: the record the file belongs to (e.g. `project`), null for plain uploads. */
  entityType?: string | null;
  /** Drive files only: the Details panel description (HTML). */
  description?: string | null;
  /** Drive files only: the caller's role on the file. */
  accessRole?: DriveAccessRole;
  /** Drive files only: the general access in force, counting the folders above the file. */
  effectiveAccess?: DriveGeneralAccess;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasMore: boolean;
}

export interface FilesListResponse {
  success: boolean;
  data: UnifiedFile[];
  pagination: PaginationMeta;
}
