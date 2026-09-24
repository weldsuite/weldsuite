/**
 * @weldsuite/permissions — App registry (per-app permission matrix)
 *
 * Single source of truth for which permission objects each app exposes. An
 * object registered in an app is granted per app (`weldcrm:companies:read`);
 * an object registered in no app is workspace-level and keeps its plain key
 * (`team:read`, `billing:manage`, `weldagent:use`, …).
 *
 * An object may belong to several apps — that is the point: `companies` can
 * be granted in WeldCRM and withheld in WeldDesk. Register an object in an
 * app only when that app's screens actually read or write it; the role editor
 * shows one matrix row per (app, object) pair from this list.
 *
 * Drives: app-scoped checks (./app-scope.ts), the role/member editor matrix,
 * and the per-app data migration (./app-migration.ts).
 */

import type { PermissionAppDefinition } from './types';

/** Request header carrying the caller's app code (platform + mobile apps). */
export const APP_CONTEXT_HEADER = 'X-Weld-App';

/**
 * Header value for requests that deliberately carry no app context (the
 * workspace shell's own widgets, settings) even when made from inside a module.
 */
export const WORKSPACE_APP_CONTEXT = 'workspace';

// Object lists follow what each module's screens call: its own hooks plus the
// shared record panels it opens. Generic cross-module lookups (WeldChat
// resolving any entity's title, the workspace shell's header widgets) are
// left out on purpose; those requests fall back to the any-app check.
export const PERMISSION_APPS: readonly PermissionAppDefinition[] = [
  {
    code: 'weldcrm',
    label: 'WeldCRM',
    objects: [
      'companies', 'people', 'contacts', 'leads', 'opportunities', 'activities',
      'pipelines', 'quotes', 'lists', 'telephony', 'tasks', 'workflows',
    ],
  },
  {
    code: 'weldcommerce',
    label: 'WeldCommerce',
    objects: [
      'products', 'orders', 'categories', 'discounts', 'websites', 'inventory',
      'companies', 'people',
    ],
  },
  {
    code: 'weldstash',
    label: 'WeldStash',
    objects: [
      'products', 'inventory', 'warehouses', 'picklists', 'locations', 'suppliers',
      'orders', 'parcels', 'carriers', 'boxes', 'returns', 'pickups', 'integrations',
    ],
  },
  {
    code: 'weldbooks',
    label: 'WeldBooks',
    objects: ['entities', 'invoices', 'bills', 'journal', 'accounts', 'banking', 'reports', 'settings'],
  },
  {
    code: 'welddesk',
    label: 'WeldDesk',
    objects: [
      'tickets', 'conversations', 'articles', 'agents', 'departments', 'slas', 'settings',
      'companies', 'people', 'activities', 'telephony', 'workflows', 'integrations',
    ],
  },
  {
    code: 'weldflow',
    label: 'WeldFlow',
    objects: [
      'projects', 'tasks', 'milestones', 'time', 'files', 'companies', 'channels',
      'messages', 'integrations',
    ],
  },
  {
    code: 'weldmail',
    label: 'WeldMail',
    objects: [
      'accounts', 'messages', 'templates', 'campaigns', 'companies', 'people', 'contacts',
      'opportunities', 'pipelines', 'activities', 'channels', 'tasks', 'events',
      'calendars', 'domains',
    ],
  },
  {
    code: 'weldchat',
    label: 'WeldChat',
    objects: ['channels', 'messages', 'settings', 'tasks', 'agents'],
  },
  {
    code: 'weldmeet',
    label: 'WeldMeet',
    objects: ['meetings', 'sessions', 'recordings', 'people', 'calendars'],
  },
  {
    code: 'weldcalendar',
    label: 'WeldCalendar',
    objects: ['events', 'calendars', 'bookings', 'meetings', 'tasks', 'people', 'integrations'],
  },
  {
    code: 'weldcall',
    label: 'WeldCall',
    objects: ['activities', 'telephony'],
  },
  {
    code: 'welddrive',
    label: 'WeldDrive',
    objects: ['files', 'folders'],
  },
  {
    code: 'weldconnect',
    label: 'WeldConnect',
    objects: [
      'workflows', 'workflow-executions', 'workflow-templates', 'workflow-variables',
      'workflow-webhooks', 'integrations', 'entities', 'accounts',
    ],
  },
  {
    code: 'weldhost',
    label: 'WeldHost',
    objects: ['domains', 'dns', 'email', 'transfers'],
  },
  {
    code: 'weldsocial',
    label: 'WeldSocial',
    objects: ['accounts', 'posts', 'campaigns', 'analytics'],
  },
  {
    code: 'weldads',
    label: 'WeldAds',
    objects: ['ad_accounts', 'ad_campaigns'],
  },
  {
    code: 'weldknow',
    label: 'WeldKnow',
    objects: ['knowledge'],
  },
  {
    code: 'welddata',
    label: 'WeldData',
    objects: ['prospects', 'lists', 'companies'],
  },
  {
    code: 'weldpass',
    label: 'WeldPass',
    objects: ['secrets'],
  },
  {
    code: 'weldhr',
    label: 'WeldHR',
    objects: ['employees', 'attendance', 'leave', 'coaching', 'evaluations', 'companies', 'people'],
  },
];

/**
 * Old / alternative app codes still found in URLs, installed-app rows and
 * mobile clients, mapped onto the canonical code above. Mirrors
 * LEGACY_CODE_ALIASES in apps/web/platform/lib/apps/app-registry.ts, plus
 * the platform's `social` route segment.
 */
export const APP_CODE_ALIASES: Readonly<Record<string, string>> = {
  crm: 'weldcrm',
  commerce: 'weldcommerce',
  wms: 'weldstash',
  stash: 'weldstash',
  weldwms: 'weldstash',
  weldparcel: 'weldstash',
  parcel: 'weldstash',
  accounting: 'weldbooks',
  books: 'weldbooks',
  helpdesk: 'welddesk',
  desk: 'welddesk',
  projects: 'weldflow',
  task: 'weldconnect',
  tasks: 'weldconnect',
  connect: 'weldconnect',
  mail: 'weldmail',
  chat: 'weldchat',
  meet: 'weldmeet',
  calendar: 'weldcalendar',
  call: 'weldcall',
  drive: 'welddrive',
  data: 'welddata',
  host: 'weldhost',
  social: 'weldsocial',
  knowledge: 'weldknow',
  know: 'weldknow',
};

// ---------------------------------------------------------------------------
// Lookups (built once)
// ---------------------------------------------------------------------------

const APP_BY_CODE: ReadonlyMap<string, PermissionAppDefinition> = new Map(
  PERMISSION_APPS.map((a) => [a.code, a]),
);

const APPS_BY_OBJECT: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const app of PERMISSION_APPS) {
    for (const object of app.objects) {
      const apps = map.get(object) ?? [];
      apps.push(app.code);
      map.set(object, apps);
    }
  }
  return map;
})();

const EMPTY: readonly string[] = [];

/** Is `code` a canonical app code? (Aliases are not.) */
export function isAppCode(code: string): boolean {
  return APP_BY_CODE.has(code);
}

/** Canonical app code for a code or alias (case-insensitive), else null. */
export function normalizeAppCode(code: string): string | null {
  const lower = code.trim().toLowerCase();
  if (APP_BY_CODE.has(lower)) return lower;
  return APP_CODE_ALIASES[lower] ?? null;
}

/** The registry entry for a canonical app code. */
export function getPermissionApp(code: string): PermissionAppDefinition | undefined {
  return APP_BY_CODE.get(code);
}

/** Canonical codes of every app that exposes `object` (empty = workspace-level). */
export function getAppsForObject(object: string): readonly string[] {
  return APPS_BY_OBJECT.get(object) ?? EMPTY;
}

/** True when `object` is granted per app rather than workspace-wide. */
export function isAppScopedObject(object: string): boolean {
  return APPS_BY_OBJECT.has(object);
}
