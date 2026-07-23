/**
 * @weldsuite/permissions — Migration map (old `app:module:action` → new `object:action`)
 *
 * Single source of truth for the permission key migration. Used by:
 *   - The data migration script (rewrites `roles.permissions`,
 *     `workspace_members.permissions`, `project_members.permissions`).
 *   - Anywhere old wildcards need to be expanded into the new key set.
 *
 * The migration is idempotent: passing an already-migrated 2-segment key
 * returns the same key unchanged. This makes the data migration safe to
 * re-run.
 *
 * Wildcard handling:
 *   '*'                 → ['*']                           (unchanged — global owner)
 *   'weldcrm:*'         → enumerated full action set on every CRM object
 *   'weldcrm:*:read'    → enumerated `:read` perm on every CRM object that has it
 *   'weldcrm:leads:read' → ['leads:read']                 (single)
 *   'leads:read'        → ['leads:read']                  (already-new, idempotent)
 *   unknown             → [oldKey]                         (best-effort passthrough)
 */

// ---------------------------------------------------------------------------
// Source of truth: every old [app, module] entry from the pre-refactor catalog,
// the canonical new object key it maps to, and the actions the original
// module supported. Modules with the same new key get merged (action union).
// ---------------------------------------------------------------------------

// [oldApp, oldModule, newObject, supportedActions]
const RAW_MIGRATION: ReadonlyArray<readonly [string, string, string, readonly string[]]> = [
  // ── settings ────────────────────────────────────────────────────────────
  ['settings', 'general',       'general',       ['read', 'update']],
  ['settings', 'team',          'team',          ['read', 'create', 'update', 'delete']],
  ['settings', 'working-hours', 'working-hours', ['edit-self']],
  ['settings', 'teams',         'teams',         ['read', 'create', 'update', 'delete']],
  ['settings', 'roles',         'roles',         ['read', 'create', 'update', 'delete']],
  ['settings', 'apikeys',       'apikeys',       ['read', 'create', 'delete']],
  ['settings', 'billing',       'billing',       ['read', 'manage']],

  // ── weldcrm ─────────────────────────────────────────────────────────────
  ['weldcrm', 'leads',         'leads',         ['read', 'create', 'update', 'delete']],
  ['weldcrm', 'contacts',      'contacts',      ['read', 'create', 'update', 'delete']],
  ['weldcrm', 'opportunities', 'opportunities', ['read', 'create', 'update', 'delete']],
  ['weldcrm', 'activities',    'activities',    ['read', 'create', 'update', 'delete']],
  ['weldcrm', 'pipelines',     'pipelines',     ['read', 'create', 'update', 'delete', 'manage']],
  ['weldcrm', 'quotes',        'quotes',        ['read', 'create', 'update', 'delete']],
  ['weldcrm', 'telephony',     'telephony',     ['read', 'manage']],

  // ── weldstash (WMS) ─────────────────────────────────────────────────────
  ['weldstash', 'products',   'products',   ['read', 'create', 'update', 'delete']],
  ['weldstash', 'inventory',  'inventory',  ['read', 'update', 'manage']],
  ['weldstash', 'orders',     'orders',     ['read', 'create', 'update', 'delete']],
  ['weldstash', 'picklists',  'picklists',  ['read', 'create', 'update', 'delete']],
  ['weldstash', 'locations',  'locations',  ['read', 'create', 'update', 'delete']],
  ['weldstash', 'warehouses', 'warehouses', ['read', 'create', 'update', 'delete', 'manage']],
  ['weldstash', 'suppliers',  'suppliers',  ['read', 'create', 'update', 'delete']],

  // ── weldbooks (Accounting) ──────────────────────────────────────────────
  ['weldbooks', 'entities',  'entities',  ['read', 'create', 'update', 'delete', 'manage']],
  ['weldbooks', 'invoices',  'invoices',  ['read', 'create', 'update', 'delete']],
  ['weldbooks', 'bills',     'bills',     ['read', 'create', 'update', 'delete']],
  ['weldbooks', 'journal',   'journal',   ['read', 'create', 'update', 'delete', 'manage']],
  ['weldbooks', 'accounts',  'accounts',  ['read', 'create', 'update', 'delete', 'manage']],
  ['weldbooks', 'banking',   'banking',   ['read', 'create', 'update', 'manage']],
  ['weldbooks', 'suppliers', 'suppliers', ['read', 'create', 'update', 'delete']],
  ['weldbooks', 'customers', 'customers', ['read', 'create', 'update', 'delete']],
  ['weldbooks', 'reports',   'reports',   ['read', 'manage']],

  // ── welddesk (Helpdesk) ─────────────────────────────────────────────────
  ['welddesk', 'tickets',       'tickets',       ['read', 'create', 'update', 'delete']],
  ['welddesk', 'conversations', 'conversations', ['read', 'create', 'update', 'delete']],
  ['welddesk', 'articles',      'articles',      ['read', 'create', 'update', 'delete']],
  ['welddesk', 'agents',        'agents',        ['read', 'create', 'update', 'delete', 'manage']],
  ['welddesk', 'departments',   'departments',   ['read', 'create', 'update', 'delete', 'manage']],
  ['welddesk', 'slas',          'slas',          ['read', 'create', 'update', 'delete', 'manage']],
  ['welddesk', 'settings',      'settings',      ['read', 'update', 'manage']],
  // WeldDesk v2 (Intercom rebuild) objects
  ['welddesk', 'inboxes',       'inboxes',       ['read', 'create', 'update', 'delete', 'manage']],
  ['welddesk', 'workflows',     'helpdesk-workflows', ['read', 'create', 'update', 'delete']],
  ['welddesk', 'macros',        'macros',        ['read', 'create', 'update', 'delete']],
  ['welddesk', 'news',          'news',          ['read', 'create', 'update', 'delete']],
  ['welddesk', 'ai',            'helpdesk-ai',   ['read', 'update', 'manage']],

  // ── weldparcel ──────────────────────────────────────────────────────────
  ['weldparcel', 'orders',   'orders',   ['read', 'create', 'update', 'delete']],
  ['weldparcel', 'parcels',  'parcels',  ['read', 'create', 'update', 'delete']],
  ['weldparcel', 'carriers', 'carriers', ['read', 'create', 'update', 'delete', 'manage']],
  ['weldparcel', 'boxes',    'boxes',    ['read', 'create', 'update', 'delete']],
  ['weldparcel', 'returns',  'returns',  ['read', 'create', 'update', 'delete']],
  ['weldparcel', 'pickups',  'pickups',  ['read', 'create', 'update', 'delete']],
  ['weldparcel', 'webhooks', 'webhooks', ['read', 'create', 'update', 'delete', 'manage']],

  // ── weldflow (Projects) ─────────────────────────────────────────────────
  ['weldflow', 'projects',   'projects',   ['read', 'create', 'update', 'delete']],
  ['weldflow', 'tasks',      'tasks',      ['read', 'create', 'update', 'delete']],
  ['weldflow', 'milestones', 'milestones', ['read', 'create', 'update', 'delete']],
  ['weldflow', 'time',       'time',       ['read', 'create', 'update', 'delete']],
  ['weldflow', 'files',      'files',      ['read', 'create', 'update', 'delete']],

  // ── weldmail ────────────────────────────────────────────────────────────
  ['weldmail', 'accounts',  'accounts',  ['read', 'create', 'update', 'delete', 'manage']],
  ['weldmail', 'messages',  'messages',  ['read', 'create', 'update', 'delete']],
  ['weldmail', 'templates', 'templates', ['read', 'create', 'update', 'delete']],
  ['weldmail', 'campaigns', 'campaigns', ['read', 'create', 'update', 'delete']],

  // ── weldhost ────────────────────────────────────────────────────────────
  ['weldhost', 'domains', 'domains', ['read', 'create', 'update', 'delete']],
  ['weldhost', 'dns',     'dns',     ['read', 'create', 'update', 'delete']],
  ['weldhost', 'email',   'email',   ['read', 'create', 'update', 'delete']],

  // ── weldchat ────────────────────────────────────────────────────────────
  ['weldchat', 'channels', 'channels', ['read', 'create', 'update', 'delete']],
  ['weldchat', 'messages', 'messages', ['read', 'create', 'update', 'delete']],
  ['weldchat', 'settings', 'settings', ['read', 'update', 'manage']],

  // ── weldconnect ─────────────────────────────────────────────────────────
  ['weldconnect', 'tasks',        'tasks',        ['read', 'create', 'update', 'delete']],
  // 'weldconnect:integrations:*' uses non-standard 4-segment keys
  // (e.g. 'weldconnect:integrations:github:manage'). Migrating it
  // collapses to 'integrations:github:manage'. We list the supported
  // terminal action 'github:manage' as the action segment so wildcard
  // expansion stays well-defined.
  ['weldconnect', 'integrations', 'integrations', ['github:manage']],

  // ── welddrive ───────────────────────────────────────────────────────────
  ['welddrive', 'files',   'files',   ['read', 'create', 'update', 'delete']],
  ['welddrive', 'folders', 'folders', ['read', 'create', 'update', 'delete']],

  // ── weldcalendar ────────────────────────────────────────────────────────
  ['weldcalendar', 'events',    'events',    ['read', 'create', 'update', 'delete']],
  ['weldcalendar', 'calendars', 'calendars', ['read', 'create', 'update', 'delete', 'manage']],
  ['weldcalendar', 'bookings',  'bookings',  ['read', 'create', 'update', 'delete']],

  // ── weldmeet ────────────────────────────────────────────────────────────
  ['weldmeet', 'meetings',   'meetings',   ['read', 'create', 'update', 'delete']],
  ['weldmeet', 'sessions',   'sessions',   ['read', 'create', 'update', 'delete']],
  ['weldmeet', 'recordings', 'recordings', ['read', 'delete']],

  // ── weldsocial ──────────────────────────────────────────────────────────
  ['weldsocial', 'accounts',  'accounts',  ['read', 'create', 'update', 'delete', 'manage']],
  ['weldsocial', 'posts',     'posts',     ['read', 'create', 'update', 'delete']],
  ['weldsocial', 'campaigns', 'campaigns', ['read', 'create', 'update', 'delete']],
  ['weldsocial', 'analytics', 'analytics', ['read']],
];

// ---------------------------------------------------------------------------
// Derived lookups
// ---------------------------------------------------------------------------

/**
 * Maps old `<app>:<module>` to the canonical new object key.
 * Built from RAW_MIGRATION.
 */
export const OLD_MODULE_TO_NEW_OBJECT: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const [app, module, newObject] of RAW_MIGRATION) {
    map[`${app}:${module}`] = newObject;
  }
  return map;
})();

/**
 * All app keys present in the old format. Used for wildcard expansion.
 */
export const OLD_APP_KEYS: readonly string[] = (() => {
  const set = new Set<string>();
  for (const [app] of RAW_MIGRATION) set.add(app);
  return [...set];
})();

/**
 * Reverse direction: which new object keys originated from a given old app.
 * Used by app-gate / app-access-guard to ask "does the user have any access
 * to objects that used to belong to weldcrm?".
 */
export const APP_TO_OBJECTS: Record<string, string[]> = (() => {
  const map: Record<string, Set<string>> = {};
  for (const [app, , newObject] of RAW_MIGRATION) {
    const set = map[app] ?? (map[app] = new Set());
    set.add(newObject);
  }
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(map)) out[k] = [...v];
  return out;
})();

/**
 * Per-old-app map of new-object → action union (across all modules merged
 * into that object from this app). Used to enumerate `weldcrm:*` and
 * `weldcrm:*:read` wildcards.
 */
const APP_OBJECT_ACTIONS: Record<string, Record<string, string[]>> = (() => {
  const out: Record<string, Record<string, Set<string>>> = {};
  for (const [app, , newObject, actions] of RAW_MIGRATION) {
    const objectMap = out[app] ?? (out[app] = {});
    const actionSet = objectMap[newObject] ?? (objectMap[newObject] = new Set());
    for (const a of actions) actionSet.add(a);
  }
  const flat: Record<string, Record<string, string[]>> = {};
  for (const [app, objectMap] of Object.entries(out)) {
    const flatObjects: Record<string, string[]> = {};
    for (const [obj, actionSet] of Object.entries(objectMap)) {
      flatObjects[obj] = [...actionSet];
    }
    flat[app] = flatObjects;
  }
  return flat;
})();

/**
 * Action union per new object across ALL old apps that contributed to it.
 * This is the canonical action list used by the rewritten catalog.
 */
export const OBJECT_ACTIONS: Record<string, string[]> = (() => {
  const out: Record<string, Set<string>> = {};
  for (const [, , newObject, actions] of RAW_MIGRATION) {
    const set = out[newObject] ?? (out[newObject] = new Set());
    for (const a of actions) set.add(a);
  }
  const flat: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(out)) flat[k] = [...v];
  return flat;
})();

/**
 * All canonical new object keys (deduped, in declaration order).
 */
export const ALL_OBJECT_KEYS: readonly string[] = (() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const [, , newObject] of RAW_MIGRATION) {
    if (!seen.has(newObject)) {
      seen.add(newObject);
      out.push(newObject);
    }
  }
  return out;
})();

// ---------------------------------------------------------------------------
// Migration helpers
// ---------------------------------------------------------------------------

/**
 * Migrate a single permission key from the old `app:module:action` format
 * to the new `object:action` format. Handles wildcards.
 *
 * Returns an array because one wildcard can expand into many concrete keys.
 *
 * Idempotent: an already-new 2-segment key (or '*') is returned unchanged.
 *
 * @example
 * migratePermissionKey('*')                      // ['*']
 * migratePermissionKey('weldcrm:leads:read')     // ['leads:read']
 * migratePermissionKey('welddesk:settings:read') // ['settings:read']
 * migratePermissionKey('weldcrm:*:read')         // ['leads:read', 'contacts:read', ...]
 * migratePermissionKey('weldcrm:*')              // ['leads:read', 'leads:create', ...]
 * migratePermissionKey('leads:read')             // ['leads:read']  (idempotent)
 */
export function migratePermissionKey(oldKey: string): string[] {
  // Global wildcard
  if (oldKey === '*') return ['*'];

  const parts = oldKey.split(':');
  const [app, second, ...rest] = parts;

  if (!app || !second) {
    // Malformed / unrecognised — return as-is, best-effort
    return [oldKey];
  }

  // 2-segment key. If the first segment is an old app key, this is the
  // legacy `weldcrm:*` wildcard form — fall through to wildcard expansion.
  // Otherwise it's already in the new `object:action` format (idempotent).
  if (parts.length === 2 && !OLD_APP_KEYS.includes(app)) {
    return [oldKey];
  }

  // App not in old map → can't migrate; return as-is
  if (!OLD_APP_KEYS.includes(app)) {
    return [oldKey];
  }

  // weldcrm:* — every action on every object that came from this app
  if (second === '*' && rest.length === 0) {
    const objectActions = APP_OBJECT_ACTIONS[app] ?? {};
    const out: string[] = [];
    for (const [obj, actions] of Object.entries(objectActions)) {
      for (const action of actions) {
        out.push(`${obj}:${action}`);
      }
    }
    return out;
  }

  // weldcrm:*:read — given action on every object from this app that supports it
  if (second === '*' && rest.length === 1) {
    const action = rest[0];
    if (!action) return [oldKey];
    const objectActions = APP_OBJECT_ACTIONS[app] ?? {};
    const out: string[] = [];
    for (const [obj, actions] of Object.entries(objectActions)) {
      if (actions.includes(action)) {
        out.push(`${obj}:${action}`);
      }
    }
    return out;
  }

  // weldcrm:leads:* — every action on a single object (within this app)
  if (rest.length === 1 && rest[0] === '*') {
    const newObject = OLD_MODULE_TO_NEW_OBJECT[`${app}:${second}`];
    if (!newObject) return [oldKey];
    const objectActions = APP_OBJECT_ACTIONS[app]?.[newObject] ?? [];
    return objectActions.map((a) => `${newObject}:${a}`);
  }

  // Concrete key: weldcrm:leads:read OR weldconnect:integrations:github:manage
  // (the latter has rest.length === 2 — preserve all trailing segments)
  const newObject = OLD_MODULE_TO_NEW_OBJECT[`${app}:${second}`];
  if (!newObject) return [oldKey];
  const trailing = rest.join(':');
  return [trailing ? `${newObject}:${trailing}` : newObject];
}

/**
 * Migrate a list of permission keys, deduplicating the output.
 * Used by the data migration script and by anything that needs to translate
 * stored permissions into the new format.
 */
export function migratePermissionKeys(oldKeys: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of oldKeys) {
    for (const migrated of migratePermissionKey(k)) {
      if (!seen.has(migrated)) {
        seen.add(migrated);
        out.push(migrated);
      }
    }
  }
  return out;
}
