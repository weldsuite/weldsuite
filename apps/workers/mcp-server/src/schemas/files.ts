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
  fileName: z.string().min(1).max(500),
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
  fileName: z.string().min(1).max(500).optional(),
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
  fileType: DriveFileType | string;
  mimeType: string | null;
  fileSize: number | null;
  url: string | null;
  thumbnailUrl: string | null;
  source: DriveSource | string;
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
