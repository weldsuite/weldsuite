/**
 * @weldsuite/permissions — Rewrite stored grants to the per-app format
 *
 * Used by the tenant sweep (apps/tools/migrate-databases
 * migrate-app-permissions.ts) to rewrite `roles.permissions` and
 * `workspace_members.permissions` from `object:action` to
 * `app:object:action`.
 *
 * Every unqualified grant on an app-scoped object is expanded into one grant
 * per app that exposes the object, so nobody gains or loses access: the
 * result is exactly what LEGACY_UNQUALIFIED_GRANTS already allows at check
 * time. Admins narrow it per app afterwards.
 *
 *   'companies:read'       → 'weldcrm:companies:read', 'weldbooks:companies:read', …
 *   'companies:*'          → 'weldcrm:companies:*', …
 *   '*:read'               → '*:read' (workspace objects) + '<app>:*:read' per app
 *   'weldcrm:companies:*'  → unchanged (already qualified)
 *   'team:read', '*'       → unchanged (workspace-level / owner)
 *   'weldparcel:orders:read' → 'weldstash:orders:read' (app alias normalized)
 *
 * Idempotent: running it on its own output returns the same set.
 */

import { PERMISSION_APPS, getAppsForObject, isAppCode, isAppScopedObject, normalizeAppCode } from './apps';
import { OLD_APP_KEYS, migratePermissionKey } from './migration-map';

function rewriteOne(key: string): string[] {
  if (key === '*') return [key];

  const parts = key.split(':');
  const [first = '', ...rest] = parts;

  // Already app-qualified (or an app-wide wildcard like `weldcrm:*`).
  if (isAppCode(first)) return [key];

  // Old app alias as first segment (`weldparcel:orders:read`, `crm:*`). An
  // alias that is also an object key (`projects`) is the object, not the app.
  const alias = parts.length >= 2 && !isAppScopedObject(first) ? normalizeAppCode(first) : null;
  if (alias) return [[alias, ...rest].join(':')];

  // Pre-2-segment workspace keys (`settings:team:read`) that were never
  // migrated: collapse them first, or `settings` would be read as the
  // module-settings object.
  if (parts.length >= 3 && OLD_APP_KEYS.includes(first)) {
    return migratePermissionKey(key).flatMap((k) => (k === key ? [k] : rewriteOne(k)));
  }

  // Cross-object wildcard (`*:read`): keep it for workspace objects and give
  // every app its own copy, since `*:read` no longer matches 3-segment keys.
  if (first === '*') {
    return [key, ...PERMISSION_APPS.map((a) => `${a.code}:${key}`)];
  }

  const apps = getAppsForObject(first);
  if (apps.length === 0) return [key];
  return apps.map((app) => `${app}:${key}`);
}

/** Rewrite a stored grant list to app-qualified keys. Order-stable, deduped. */
export function toAppScopedKeys(keys: readonly string[]): string[] {
  const out = new Set<string>();
  for (const key of keys) {
    for (const rewritten of rewriteOne(key)) out.add(rewritten);
  }
  return [...out];
}
