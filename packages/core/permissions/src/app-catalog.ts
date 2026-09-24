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
