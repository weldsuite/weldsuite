/**
 * Which platform permissions an agent may be granted, and by whom.
 */

import { hasAppPermission, hasPermission, type PermissionSubject } from '@weldsuite/permissions';
import { getAllPermissionKeys } from '@weldsuite/permissions/catalog';

/** Self-management and settings noise are never granted: agents act on data objects. */
const NEVER_GRANTED = ['weldagent:', 'team:', 'roles:', 'apikeys:', 'billing:', 'general:'];

/** Catalog keys an agent may hold (`computer:use` / `browser:use` turn on the sandbox and web tools). */
export function grantableAgentPermissions(): string[] {
  return getAllPermissionKeys().filter((key) => !NEVER_GRANTED.some((prefix) => key.startsWith(prefix)));
}

/**
 * Does the person granting hold `perm`? Agent grants are plain catalog keys
 * (`people:read`) while a person's may be per app (`weldcrm:people:read`), so
 * a grant in any app counts; their own denies apply.
 */
export function granterHolds(subject: PermissionSubject, perm: string): boolean {
  return hasPermission(subject.permissions, perm) || hasAppPermission(subject, perm, null);
}

/**
 * Split requested grants into those `granter` may give and those they may not.
 * Granting an agent more than you hold would let you act beyond your role
 * through it.
 */
export function splitGrantable(
  requested: string[],
  granter: PermissionSubject,
): { granted: string[]; refused: string[] } {
  const grantable = new Set(grantableAgentPermissions());
  const granted: string[] = [];
  const refused: string[] = [];
  for (const perm of new Set(requested)) {
    if (grantable.has(perm) && granterHolds(granter, perm)) granted.push(perm);
    else refused.push(perm);
  }
  return { granted, refused };
}
