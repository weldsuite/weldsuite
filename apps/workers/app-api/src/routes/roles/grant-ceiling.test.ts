/**
 * The role editor must keep working under the grant ceiling (TASK-625): an
 * Admin can grant every catalog key their own tier allows, and the system
 * tiers below Admin are within an Admin's reach.
 */

import { describe, expect, it } from 'vitest';
import {
  SYSTEM_ROLES,
  buildAppPermissionCatalog,
  checkAppPermission,
  checkPermissionGrants,
  getAllPermissionKeys,
  isGrantablePermissionKey,
} from '@weldsuite/permissions';

const admin = { permissions: [...SYSTEM_ROLES.ADMIN!.permissions] };

describe('grant ceiling', () => {
  it('treats every catalog key as grantable', () => {
    const appKeys = buildAppPermissionCatalog().apps.flatMap((a) => a.objects.flatMap((o) => o.permissions.map((p) => p.key)));
    const rejected = [...getAllPermissionKeys(), ...appKeys].filter((k) => !isGrantablePermissionKey(k));
    expect(rejected).toEqual([]);
  });

  it('lets an Admin grant every app-qualified key the Admin tier allows', () => {
    const appKeys = buildAppPermissionCatalog().apps.flatMap((a) => a.objects.flatMap((o) => o.permissions.map((p) => p.key)));
    const allowed = appKeys.filter((k) => checkAppPermission(admin, k, null).allowed);
    expect(checkPermissionGrants(admin, allowed).notHeld).toEqual([]);
  });

  it('lets an Admin assign the Member and Viewer tiers', () => {
    expect(checkPermissionGrants(admin, SYSTEM_ROLES.MEMBER!.permissions).ok).toBe(true);
    expect(checkPermissionGrants(admin, SYSTEM_ROLES.VIEWER!.permissions).ok).toBe(true);
  });

  it('accepts the keys the platform asks for through access requests', () => {
    // <AccessDeniedEmptyState permission=…> call sites in apps/web/platform.
    const requested = ['billing:manage', 'billing:read', 'passwords:use', 'taxes:read', 'team:read'];
    expect(requested.filter((k) => !isGrantablePermissionKey(k))).toEqual([]);
  });

  it('never lets anyone grant the Owner wildcard', () => {
    expect(checkPermissionGrants({ permissions: ['*'] }, ['*']).invalid).toEqual(['*']);
  });

  it('honours denies and does not widen a pattern', () => {
    expect(checkPermissionGrants({ permissions: ['leads:*'], denies: ['leads:delete'] }, ['leads:delete']).ok).toBe(false);
    expect(checkPermissionGrants({ permissions: ['leads:read'] }, ['leads:*']).ok).toBe(false);
  });
});
