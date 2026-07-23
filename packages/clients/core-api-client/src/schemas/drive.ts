/**
 * Drive cross-cutting view schemas (Zod v3) — powers /api/drive/*.
 *
 * - /all   — unified file feed across drive, projects, documents,
 *            whiteboards, mail attachments, voip + meeting recordings, social.
 * - /stats — counts per source.
 * - /trash — combined trashed files + folders.
 */

import { z } from 'zod';
import type { UnifiedFile, PaginationMeta } from './files';
import type { DriveFile } from './files';
import type { DriveFolder } from './folders';

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
