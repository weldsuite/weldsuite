/**
 * Folder schemas (Zod v3) — powers /api/folders/*.
 */

import { z } from 'zod';
import { driveNameSchema } from './files';
import { driveGeneralAccessSchema, type DriveAccessRole, type DriveGeneralAccess } from './drive-shares';

export const listFoldersQuery = z.object({
  parentId: z.string().optional(),
  all: z.coerce.boolean().optional(),
});

export const createFolderSchema = z.object({
  name: driveNameSchema,
  parentId: z.string().nullish(),
  color: z.string().optional(),
  icon: z.string().optional(),
});

export const updateFolderSchema = z.object({
  name: driveNameSchema.optional(),
  parentId: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
});

/**
 * WeldDrive's own PATCH /api/folders/:id (app-api): the shared fields plus
 * who besides the people it is shared with may open the folder.
 */
export const updateDriveFolderSchema = updateFolderSchema.extend({
  generalAccess: driveGeneralAccessSchema.optional(),
});

export type ListFoldersQuery = z.input<typeof listFoldersQuery>;
export type CreateFolderInput = z.infer<typeof createFolderSchema>;
export type UpdateFolderInput = z.infer<typeof updateFolderSchema>;
export type UpdateDriveFolderInput = z.infer<typeof updateDriveFolderSchema>;

/** A `folders` row as /api/folders answers it (`DriveFolder`). */
export const driveFolderSchema = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable(),
  color: z.string().nullable(),
  icon: z.string().nullable(),
  createdById: z.string().nullable(),
  generalAccess: driveGeneralAccessSchema,
  metadata: z.record(z.unknown()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
  accessRole: z.enum(['owner', 'viewer', 'editor']).optional(),
  effectiveAccess: driveGeneralAccessSchema.optional(),
});

export interface DriveFolder {
  id: string;
  name: string;
  parentId: string | null;
  color: string | null;
  icon: string | null;
  createdById: string | null;
  generalAccess: DriveGeneralAccess;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  /** The caller's role on the folder (app-api reads only). */
  accessRole?: DriveAccessRole;
  /** The general access in force, counting the folders above it (app-api reads only). */
  effectiveAccess?: DriveGeneralAccess;
}
