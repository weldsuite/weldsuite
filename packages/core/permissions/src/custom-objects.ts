/**
 * WeldObjects — permission keys for user-defined custom objects.
 *
 * Custom objects are created at runtime, so their permission keys cannot live
 * in the static catalog. Fortunately almost nothing needs to change: the
 * matcher in engine.ts walks segments generically and is segment-count
 * agnostic, so `weldobjects:machine:read` already matches a stored
 * `weldobjects:*`, `weldobjects:machine:*` or `*` with no engine changes at
 * all. Enforcement works today.
 *
 * What DOESN'T work without help is the role editor, which renders checkboxes
 * from `PERMISSION_CATALOG_OBJECTS`. This module builds the catalog entries for
 * tenant-defined objects so `GET /api/roles/permission-catalog` can merge them
 * into its response.
 *
 * ## Key shape
 *
 *   weldobjects:read                  see the module at all
 *   weldobjects:manage                define/edit/delete object TYPES
 *   weldobjects:<slug>:read           per-object record access
 *   weldobjects:<slug>:create
 *   weldobjects:<slug>:update
 *   weldobjects:<slug>:delete
 *   weldobjects:<slug>:scope:all      cross-owner visibility
 *
 * Three segments rather than the two-segment house style is deliberate: the
 * object identity has to be in the key or one grant would cover every custom
 * object a workspace ever creates. The migration that collapsed
 * `app:module:action` into `object:action` was about removing a redundant
 * dimension; here the middle segment carries real information.
 *
 * `weldobjects:manage` is a settings-level grant, and a dangerous one — it
 * lets a user add fields, change relationships and delete object types along
 * with all their records. Grant it like `settings:manage`, not like
 * `leads:update`.
 */

import type { ObjectDefinition, PermissionDefinition } from './types';

/** Permission prefix owned by the WeldObjects module. */
export const WELDOBJECTS_PREFIX = 'weldobjects';

/** Module-level keys, present regardless of how many objects exist. */
export const WELDOBJECTS_MODULE_PERMISSIONS = [
  `${WELDOBJECTS_PREFIX}:read`,
  `${WELDOBJECTS_PREFIX}:manage`,
] as const;

/** Per-object record actions. */
export const CUSTOM_OBJECT_ACTIONS = ['read', 'create', 'update', 'delete'] as const;
export type CustomObjectPermissionAction = (typeof CUSTOM_OBJECT_ACTIONS)[number];

/** The minimal object shape needed to build permission entries. */
export interface CustomObjectPermissionSource {
  slug: string;
  labelPlural: string;
}

/** `('machine', 'read')` → `'weldobjects:machine:read'`. */
export function customObjectPermission(
  slug: string,
  action: CustomObjectPermissionAction,
): string {
  return `${WELDOBJECTS_PREFIX}:${slug}:${action}`;
}

/** The cross-owner grant for one object. */
export function customObjectScopeAllPermission(slug: string): string {
  return `${WELDOBJECTS_PREFIX}:${slug}:scope:all`;
}

/** Every permission key one custom object contributes. */
export function customObjectPermissionKeys(slug: string): string[] {
  return [
    ...CUSTOM_OBJECT_ACTIONS.map((action) => customObjectPermission(slug, action)),
    customObjectScopeAllPermission(slug),
  ];
}

const ACTION_LABELS: Record<CustomObjectPermissionAction, string> = {
  read: 'View',
  create: 'Create',
  update: 'Edit',
  delete: 'Delete',
};

/**
 * Catalog entry for one custom object, shaped exactly like the entries
 * `objectPermissions()` produces in catalog.ts so the role editor can render
 * them through the same code path.
 */
export function customObjectPermissionObject(
  object: CustomObjectPermissionSource,
): ObjectDefinition {
  const lower = object.labelPlural.toLowerCase();
  const permissions: PermissionDefinition[] = CUSTOM_OBJECT_ACTIONS.map((action) => ({
    key: customObjectPermission(object.slug, action),
    label: `${ACTION_LABELS[action]} ${lower}`,
  }));

  permissions.push({
    key: customObjectScopeAllPermission(object.slug),
    label: `See all ${lower} (not only their own)`,
    description: `Without this grant, the user can only read/edit ${lower} they own. Grant to managers and admins who need cross-team visibility.`,
  });

  return {
    key: `${WELDOBJECTS_PREFIX}:${object.slug}`,
    label: object.labelPlural,
    permissions,
  };
}

/**
 * Build the full set of custom-object catalog entries for a workspace.
 *
 * Returned as a separate array rather than spliced into the static catalog so
 * the role editor can render them in their own collapsible group. That matters
 * more than it sounds: five keys per object means a workspace with forty
 * objects contributes two hundred checkboxes, and mixing those into the
 * first-party list would drown it.
 */
export function buildCustomObjectPermissionCatalog(
  objects: readonly CustomObjectPermissionSource[],
): ObjectDefinition[] {
  return objects.map(customObjectPermissionObject);
}

/**
 * True when a permission key belongs to a custom object (i.e. is one of the
 * three-segment `weldobjects:<slug>:<action>` forms), as opposed to a
 * module-level `weldobjects:read` / `weldobjects:manage`.
 */
export function isCustomObjectPermission(key: string): boolean {
  const parts = key.split(':');
  return parts.length >= 3 && parts[0] === WELDOBJECTS_PREFIX;
}
