/**
 * Drive cross-cutting view schemas (Zod v3) — powers /api/drive/*.
 *
 * - /all   — unified file feed across drive, projects, documents,
 *            whiteboards, mail attachments, voip + meeting recordings, social.
 * - /stats — counts per source.
 * - /trash — combined trashed files + folders.
 */

import { z } from 'zod';
import { driveFileSchema, unifiedFileSchema, type UnifiedFile, type PaginationMeta, type DriveFile } from './files';
import { driveFolderSchema, type DriveFolder } from './folders';
import { driveShareRoleSchema } from './drive-shares';

export const listAllFilesQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
  search: z.string().optional(),
  type: z.string().optional(),
  source: z.string().optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
});

export type ListAllFilesQuery = z.input<typeof listAllFilesQuery>;

export interface DriveFilesResponse {
  success: boolean;
  data: UnifiedFile[];
  pagination: PaginationMeta;
  summary?: {
    totalFiles: number;
    byType: Record<string, number>;
    bySource: Record<string, number>;
  };
}

export interface DriveStats {
  totalFiles: number;
  recentCount: number;
  bySource: Record<string, number>;
}

export interface DriveStatsResponse {
  success: boolean;
  data: DriveStats;
}

export interface DriveTrash {
  files: DriveFile[];
  folders: DriveFolder[];
}

// ============================================================================
// Response schemas (Zod), matching the interfaces above and in drive-shares
// ============================================================================

/** GET /api/drive/stats. */
export const driveStatsSchema = z.object({
  totalFiles: z.number(),
  recentCount: z.number(),
  bySource: z.record(z.number()),
});

/** GET /api/drive/trash. */
export const driveTrashSchema = z.object({
  files: z.array(driveFileSchema),
  folders: z.array(driveFolderSchema),
});

const sharedFields = {
  sharedRole: driveShareRoleSchema,
  sharedBy: z.string(),
  sharedAt: z.string(),
};

/** GET /api/drive/shared (`SharedWithMe`). */
export const sharedWithMeSchema = z.object({
  files: z.array(unifiedFileSchema.extend(sharedFields)),
  folders: z.array(driveFolderSchema.extend(sharedFields)),
});

/** POST /api/drive/trash/restore/{file,folder}/:id. */
export const restoredResultSchema = z.object({ restored: z.literal(true) });
/** DELETE /api/drive/trash/empty. */
export const emptiedResultSchema = z.object({ emptied: z.literal(true) });
