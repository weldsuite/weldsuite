// AUTO-COPIED from @weldsuite/core-api-client/schemas/folders
// Self-contained Zod schemas vendored into mcp-server so it no longer
// depends on @weldsuite/{core-api,app-api}-client. Keep in sync with source.

/**
 * Folder schemas (Zod v3) — powers /api/folders/*.
 */

import { z } from 'zod';

export const listFoldersQuery = z.object({
  parentId: z.string().optional(),
  all: z.coerce.boolean().optional(),
});

export const createFolderSchema = z.object({
  name: z.string().min(1).max(500),
  parentId: z.string().nullish(),
  color: z.string().optional(),
  icon: z.string().optional(),
});

export const updateFolderSchema = z.object({
  name: z.string().min(1).max(500).optional(),
  parentId: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
});

export type ListFoldersQuery = z.input<typeof listFoldersQuery>;
export type CreateFolderInput = z.infer<typeof createFolderSchema>;
export type UpdateFolderInput = z.infer<typeof updateFolderSchema>;

export interface DriveFolder {
  id: string;
  name: string;
  parentId: string | null;
  color: string | null;
  icon: string | null;
  createdById: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
