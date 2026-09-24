/**
 * @weldsuite/permissions — App registry (per-app permission matrix)
 *
 * Single source of truth for which permission objects each app exposes. An
 * object registered in an app is granted per app (`weldcrm:companies:read`);
 * an object registered in no app is workspace-level and keeps its plain key
 * (`team:read`, `billing:manage`, `weldagent:use`, …).
 *
 * An object may belong to several apps — that is the point: `companies` can
 * be granted in WeldCRM and withheld in WeldBooks. Register an object in an
 * app only when that app's screens actually read or write it; the role editor
 * shows one matrix row per (app, object) pair from this list.
 *
 * Drives: app-scoped checks (./app-scope.ts), the role/member editor matrix,
 * and the per-app data migration.
 */

import type { PermissionAppDefinition } from './types';

/** Request header carrying the caller's app code (platform + mobile apps). */
export const APP_CONTEXT_HEADER = 'X-Weld-App';

export const PERMISSION_APPS: readonly PermissionAppDefinition[] = [
  {
    code: 'weldcrm',
    label: 'WeldCRM',
    objects: [
      'companies', 'people', 'customers', 'contacts', 'leads', 'opportunities',
      'activities', 'pipelines', 'quotes', 'lists', 'telephony', 'products',
    ],
  },
  {
    code: 'weldcommerce',
    label: 'WeldCommerce',
    objects: [
      'products', 'orders', 'customers', 'companies', 'people', 'categories',
      'discounts', 'websites', 'inventory', 'returns',
    ],
  },
  {
    code: 'weldstash',
    label: 'WeldStash',
    objects: [
      'products', 'inventory', 'orders', 'picklists', 'locations', 'warehouses',
      'suppliers', 'parcels', 'carriers', 'boxes', 'returns', 'pickups', 'webhooks',
    ],
  },
  {
    code: 'weldbooks',
    label: 'WeldBooks',
    objects: [
      'entities', 'invoices', 'bills', 'journal', 'accounts', 'banking', 'reports',
      'suppliers', 'customers', 'companies', 'people', 'products',
    ],
  },
  {
    code: 'welddesk',
    label: 'WeldDesk',
    objects: [
      'tickets', 'conversations', 'articles', 'agents', 'departments', 'slas',
      'settings', 'customers', 'companies', 'people',
    ],
  },
  {
    code: 'weldflow',
    label: 'WeldFlow',
    objects: ['projects', 'tasks', 'milestones', 'time', 'files'],
  },
  {
    code: 'weldmail',
    label: 'WeldMail',
    objects: ['accounts', 'messages', 'templates', 'campaigns'],
  },
  {
    code: 'weldchat',
    label: 'WeldChat',
    objects: ['channels', 'messages', 'settings'],
  },
  {
    code: 'weldmeet',
    label: 'WeldMeet',
    objects: ['meetings', 'sessions', 'recordings'],
  },
  {
    code: 'weldcalendar',
    label: 'WeldCalendar',
    objects: ['events', 'calendars', 'bookings'],
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
      'workflows', 'workflow-executions', 'workflow-templates',
      'workflow-variables', 'workflow-webhooks', 'integrations',
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
    objects: ['prospects'],
  },
  {
    code: 'weldpass',
    label: 'WeldPass',
    objects: ['secrets'],
  },
  {
    code: 'weldhr',
    label: 'WeldHR',
    objects: ['employees', 'attendance', 'leave', 'coaching', 'evaluations'],
  },
];

/**
 * Old / alternative app codes still found in URLs, installed-app rows and
 * mobile clients, mapped onto the canonical code above.
 */
export const APP_CODE_ALIASES: Readonly<Record<string, string>> = {
  crm: 'weldcrm',
  commerce: 'weldcommerce',
  wms: 'weldstash',
  accounting: 'weldbooks',
  helpdesk: 'welddesk',
  projects: 'weldflow',
  task: 'weldflow',
  mail: 'weldmail',
  chat: 'weldchat',
  meet: 'weldmeet',
  calendar: 'weldcalendar',
  drive: 'welddrive',
  host: 'weldhost',
  social: 'weldsocial',
  weldparcel: 'weldstash',
  parcel: 'weldstash',
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
