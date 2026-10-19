/**
 * Hono glue for the WeldDrive access rules (`@weldsuite/core-domain/drive-access`):
 * who is asking, and the rules loaded for them once per request.
 */

import type { Context } from 'hono';
import { getPermissionsFromContext } from '@weldsuite/permissions/server';
import {
  isWorkspaceAdmin,
  loadDriveAccess,
  type DriveAccessIndex,
  type DriveCaller,
} from '@weldsuite/core-domain/drive-access';
import type { Env, Variables } from '../types';

type DriveContext = Context<{ Bindings: Env; Variables: Variables }>;

/** The caller as the Drive rules see them. Workspace OWNER / ADMIN open every item. */
export async function driveCaller(c: DriveContext): Promise<DriveCaller> {
  const userId = c.get('userId') ?? null;
  if (!userId) return { userId: null, isAdmin: false };
  // requirePermission has usually resolved the member already; reuse it.
  const resolved = getPermissionsFromContext(c);
  if (resolved) {
    const role = resolved.role.toUpperCase();
    return { userId, isAdmin: resolved.isOwner || role === 'OWNER' || role === 'ADMIN' };
  }
  return { userId, isAdmin: await isWorkspaceAdmin(c.get('tenantDb'), userId) };
}

/** The Drive rules for this request's caller. */
export async function driveAccess(c: DriveContext): Promise<DriveAccessIndex> {
  return loadDriveAccess(c.get('tenantDb'), await driveCaller(c));
}

export const DRIVE_VIEW_ONLY = 'You can view this item but not change it';
export const DRIVE_FOLDER_HOLDS_LOCKED_FILES =
  'This folder holds files you cannot change, so it cannot be deleted permanently. Their owners can move or delete them first';
export const DRIVE_MODULE_FILE ='This file belongs to a record in another module, which decides who can open it';
