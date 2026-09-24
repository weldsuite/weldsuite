/**
 * @weldsuite/permissions — Per-app view of the permission catalog
 *
 * Joins the object catalog with the app registry: every app gets its own copy
 * of the objects it exposes, with app-qualified keys
 * (`weldcrm:companies:read`). Objects registered in no app are returned once,
 * under `workspace`, with their plain keys. This is the shape the role and
 * member editors render as one matrix per app.
 */

import { PERMISSION_CATALOG_OBJECTS } from './catalog';
import { PERMISSION_APPS, isAppScopedObject } from './apps';
import { checkAppPermission, type PermissionSubject } from './app-scope';
import { hasObjectAccess } from './engine';
import type { ObjectDefinition } from './types';

export interface AppPermissionCatalogEntry {
  /** Canonical app code, e.g. "weldcrm" */
  app: string;
  label: string;
  /** Objects this app exposes; permission keys are app-qualified. */
  objects: ObjectDefinition[];
}

export interface AppPermissionCatalog {
  apps: AppPermissionCatalogEntry[];
  /** Workspace-level objects (no app segment). */
  workspace: ObjectDefinition[];
}

export function buildAppPermissionCatalog(): AppPermissionCatalog {
  const byKey = new Map(PERMISSION_CATALOG_OBJECTS.map((o) => [o.key, o]));

  const apps = PERMISSION_APPS.map((app) => ({
    app: app.code,
    label: app.label,
    objects: app.objects.flatMap((objectKey) => {
      const object = byKey.get(objectKey);
      if (!object) return [];
      return [{
        ...object,
        permissions: object.permissions.map((p) => ({ ...p, key: `${app.code}:${p.key}` })),
      }];
    }),
  }));

  const workspace = PERMISSION_CATALOG_OBJECTS.filter((o) => !isAppScopedObject(o.key));

  return { apps, workspace };
}

const CATALOG_KEYS_BY_OBJECT: ReadonlyMap<string, readonly string[]> = new Map(
  PERMISSION_CATALOG_OBJECTS.map((o) => [o.key, o.permissions.map((p) => p.key)]),
);

/**
 * Does the subject hold ANY permission on `object` in `app` (deny-aware)?
 * Checks each concrete catalog key for the object through
 * `checkAppPermission`, so wildcards, legacy unqualified grants and denies all
 * behave exactly as they do for a single-key check. Workspace-level objects
 * keep the plain prefix match, since they carry runtime keys the static
 * catalog doesn't list (`weldobjects:<slug>:read`).
 */
export function hasObjectAccessInApp(
  subject: PermissionSubject,
  object: string,
  app: string | null | undefined,
): boolean {
  if (subject.permissions.includes('*') && !subject.denies?.length) return true;
  const keys = CATALOG_KEYS_BY_OBJECT.get(object);
  if (!keys || !isAppScopedObject(object)) return hasObjectAccess(subject.permissions, object);
  return keys.some((key) => checkAppPermission(subject, key, app).allowed);
}

/** Any access to at least one of `objects` in `app`. */
export function hasAnyObjectAccessInApp(
  subject: PermissionSubject,
  objects: readonly string[],
  app: string | null | undefined,
): boolean {
  return objects.some((object) => hasObjectAccessInApp(subject, object, app));
}
