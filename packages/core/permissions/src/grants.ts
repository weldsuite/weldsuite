/**
 * @weldsuite/permissions — What a member may hand out
 *
 * Roles, per-member extras and role assignments all widen someone's access, so
 * every write that does so goes through `checkPermissionGrants`:
 *
 * 1. Only real keys: catalog keys (plain and app-qualified), custom-object keys
 *    and the keys the system roles use. Unknown strings are rejected instead of
 *    stored, since a later catalog addition would silently turn them live.
 * 2. No workspace-wide wildcard: `*` and `*:<action>` belong to the Owner alone
 *    (who holds `*` by resolution, never through a role row).
 * 3. A grant ceiling: the grantor must hold every key they grant. Without it a
 *    `roles:create` holder mints a role with everything and assigns it to
 *    themselves.
 *
 * Keys a role or member already has are not re-checked, so editing an existing
 * role with a legacy key, or one the editor doesn't hold, keeps working; only
 * what is being ADDED must pass.
 */

import { hasPermission } from './engine';
import { LEGACY_UNQUALIFIED_GRANTS, parsePermissionKey, type PermissionSubject } from './app-scope';
import { buildAppPermissionCatalog } from './app-catalog';
import { EMPLOYEE_MEMBER_PERMISSIONS, SYSTEM_ROLES, getAllPermissionKeys } from './catalog';
import { WELDOBJECTS_MODULE_PERMISSIONS, isCustomObjectPermission } from './custom-objects';

const KEY_SEGMENT = /^[a-z0-9_*-]+$/i;
const MAX_KEY_LENGTH = 200;

let knownKeys: ReadonlySet<string> | null = null;

function getKnownKeys(): ReadonlySet<string> {
  if (knownKeys) return knownKeys;
  const keys = new Set<string>(getAllPermissionKeys());
  const catalog = buildAppPermissionCatalog();
  for (const app of catalog.apps) {
    for (const object of app.objects) {
      for (const permission of object.permissions) keys.add(permission.key);
    }
  }
  for (const role of Object.values(SYSTEM_ROLES)) {
    for (const key of role.permissions) if (key !== '*') keys.add(key);
  }
  for (const key of EMPLOYEE_MEMBER_PERMISSIONS) keys.add(key);
  for (const key of WELDOBJECTS_MODULE_PERMISSIONS) keys.add(key);
  knownKeys = keys;
  return keys;
}

/**
 * Is `key` something a role or member may be granted at all? Concrete keys
 * must exist; a wildcard pattern must cover at least one existing key and may
 * not start with `*`.
 */
export function isGrantablePermissionKey(key: string): boolean {
  if (!key || key.length > MAX_KEY_LENGTH) return false;
  const segments = key.split(':');
  if (!segments.every((s) => KEY_SEGMENT.test(s))) return false;
  if (segments[0] === '*') return false;

  const known = getKnownKeys();
  if (known.has(key)) return true;
  // `weldobjects:<slug>:<action>` keys exist per tenant at runtime.
  if (isCustomObjectPermission(key)) return true;
  if (!key.includes('*')) return false;
  for (const candidate of known) {
    if (hasPermission([key], candidate)) return true;
  }
  return false;
}

/**
 * Does the grantor hold `key` themselves? Deny-aware. A wildcard pattern only
 * passes when the grantor's own grants cover it as a pattern (`leads:*` is
 * covered by `leads:*` or `*`, never by `leads:read`).
 */
export function canGrantPermission(grantor: PermissionSubject, key: string): boolean {
  const parsed = key.includes('*') ? null : parsePermissionKey(key);
  const unqualified = parsed?.app ? parsed.unqualified : null;

  const denies = grantor.denies ?? [];
  if (hasPermission(denies, key) || (unqualified && hasPermission(denies, unqualified))) return false;

  if (hasPermission(grantor.permissions, key)) return true;
  return Boolean(unqualified && LEGACY_UNQUALIFIED_GRANTS && hasPermission(grantor.permissions, unqualified));
}

export interface PermissionGrantCheck {
  ok: boolean;
  /** Keys that are not permissions at all (unknown, malformed, `*`). */
  invalid: string[];
  /** Real keys the grantor does not hold and so may not hand out. */
  notHeld: string[];
}

/**
 * Check a permission list someone wants to grant.
 *
 * @param grantor        - the caller's resolved permissions
 * @param requested      - the full list being written
 * @param alreadyGranted - what the target already has; those keys are kept
 *                         without re-checking
 */
export function checkPermissionGrants(
  grantor: PermissionSubject,
  requested: readonly string[],
  alreadyGranted: readonly string[] = [],
): PermissionGrantCheck {
  const existing = new Set(alreadyGranted);
  const invalid: string[] = [];
  const notHeld: string[] = [];
  for (const key of new Set(requested)) {
    if (existing.has(key)) continue;
    if (!isGrantablePermissionKey(key)) invalid.push(key);
    else if (!canGrantPermission(grantor, key)) notHeld.push(key);
  }
  return { ok: invalid.length === 0 && notHeld.length === 0, invalid, notHeld };
}
