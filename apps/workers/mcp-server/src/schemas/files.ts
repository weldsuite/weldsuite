// AUTO-COPIED from @weldsuite/core-api-client/schemas/files
// Self-contained Zod schemas vendored into mcp-server so it no longer
// depends on @weldsuite/{core-api,app-api}-client. Keep in sync with source.

/**
 * Files schemas (Zod v3) — powers /api/files/*.
 *
 * Single source of truth for the drive-native file store (`files` table).
 * Types lifted from the legacy `apps/web/platform/lib/api/domains/welddrive.ts`.
 */

import { z } from 'zod';

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
});

export const createFileSchema = z.object({
  // Uploads keep their own name, made usable rather than refused.
  fileName: z.string().trim().min(1).max(500).transform(sanitizeDriveName),
  originalName: z.string().optional(),
  mimeType: z.string().min(1),
  fileSize: z.number().int().min(0),
  fileType: z.string().optional().default('file'),
  // Must be keys under the workspace's own `workspaces/<id>/` prefix (checked
  // by the route). Which bucket holds the object is never taken from the client.
  storagePath: z.string().min(1).max(1000),
  fileKey: z.string().min(1).max(1000).optional(),
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

export const moveFileSchema = z.object({
  folderId: z.string().nullable(),
});

export type ListFilesQuery = z.input<typeof listFilesQuery>;
export type CreateFileInput = z.infer<typeof createFileSchema>;
export type UpdateFileInput = z.infer<typeof updateFileSchema>;
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
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
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
