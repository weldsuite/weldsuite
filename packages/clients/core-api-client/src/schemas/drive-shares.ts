/**
 * Drive sharing schemas (Zod v3) — powers the `/shares` routes on
 * /api/files/:id and /api/folders/:id, and /api/drive/shared.
 *
 * Access rules: `@weldsuite/core-domain/drive-access`.
 */

import { z } from 'zod';
import type { UnifiedFile } from './files';
import type { DriveFolder } from './folders';

/**
 * Who besides the owner and the people an item is shared with may open it:
 * everyone with Drive access (and edit it), everyone (view only), or nobody.
 */
export const DRIVE_GENERAL_ACCESS = ['workspace_edit', 'workspace_view', 'restricted'] as const;
export type DriveGeneralAccess = (typeof DRIVE_GENERAL_ACCESS)[number];
export const driveGeneralAccessSchema = z.enum(DRIVE_GENERAL_ACCESS);

/** A teammate's role on a shared item. Editors may also share it. */
export const DRIVE_SHARE_ROLES = ['viewer', 'editor'] as const;
export type DriveShareRole = (typeof DRIVE_SHARE_ROLES)[number];

/** The caller's own role on an item. */
export type DriveAccessRole = 'owner' | DriveShareRole;

export const shareDriveItemSchema = z.object({
  role: z.enum(DRIVE_SHARE_ROLES),
});

export type ShareDriveItemInput = z.infer<typeof shareDriveItemSchema>;

export interface DriveSharePerson {
  userId: string;
  name: string | null;
  email: string | null;
  picture: string | null;
}

export interface DriveShareEntry extends DriveSharePerson {
  role: DriveShareRole;
  sharedBy: string;
  createdAt: string;
}

/** Access a file or folder gets from a share on a folder above it. */
export interface InheritedDriveShareEntry extends DriveShareEntry {
  folderId: string;
  folderName: string;
}

/** GET /api/files/:id/shares and /api/folders/:id/shares. */
export interface DriveItemSharing {
  /** The uploader or creator; null when nobody is recorded. */
  owner: DriveSharePerson | null;
  /** The item's own setting. */
  generalAccess: DriveGeneralAccess;
  /** The setting in force, once the folders above the item are counted. */
  effectiveGeneralAccess: DriveGeneralAccess;
  /** The caller's role on the item. */
  accessRole: DriveAccessRole;
  shares: DriveShareEntry[];
  inherited: InheritedDriveShareEntry[];
}

/** One row of GET /api/drive/shared. */
export interface SharedDriveFile extends UnifiedFile {
  sharedRole: DriveShareRole;
  sharedBy: string;
  sharedAt: string;
}

export interface SharedDriveFolder extends DriveFolder {
  sharedRole: DriveShareRole;
  sharedBy: string;
  sharedAt: string;
}

export interface SharedWithMe {
  files: SharedDriveFile[];
  folders: SharedDriveFolder[];
}

// ============================================================================
// Response schemas (Zod), matching the interfaces above
// ============================================================================

export const driveShareRoleSchema = z.enum(DRIVE_SHARE_ROLES);
export const driveAccessRoleSchema = z.enum(['owner', ...DRIVE_SHARE_ROLES]);

export const driveSharePersonSchema = z.object({
  userId: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  picture: z.string().nullable(),
});

export const driveShareEntrySchema = driveSharePersonSchema.extend({
  role: driveShareRoleSchema,
  sharedBy: z.string(),
  createdAt: z.string(),
});

export const inheritedDriveShareEntrySchema = driveShareEntrySchema.extend({
  folderId: z.string(),
  folderName: z.string(),
});

/** GET /api/files/:id/shares and /api/folders/:id/shares. */
export const driveItemSharingSchema = z.object({
  owner: driveSharePersonSchema.nullable(),
  generalAccess: driveGeneralAccessSchema,
  effectiveGeneralAccess: driveGeneralAccessSchema,
  accessRole: driveAccessRoleSchema,
  shares: z.array(driveShareEntrySchema),
  inherited: z.array(inheritedDriveShareEntrySchema),
});
