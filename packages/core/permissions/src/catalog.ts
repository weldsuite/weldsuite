/**
 * @weldsuite/permissions — Permission Catalog
 *
 * Single source of truth for all permission definitions.
 *
 * Keys are 2-segment `object:action` (e.g. `leads:read`). Same-named modules
 * across apps are merged into a single object — see migration-map.ts for the
 * old → new mapping that produced this catalog.
 */

import { migratePermissionKeys } from './migration-map';
import type {
  ObjectDefinition,
  PermissionAction,
  PermissionDefinition,
  SystemRoleDefinition,
} from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STANDARD_ACTION_LABELS: Record<PermissionAction, string> = {
  read: 'View',
  create: 'Create',
  update: 'Edit',
  delete: 'Delete',
  manage: 'Manage',
};

function objectPermissions(
  object: string,
  label: string,
  actions: readonly string[] = ['read', 'create', 'update', 'delete'],
  opts: { scopeAll?: boolean } = {},
): ObjectDefinition {
  const permissions: PermissionDefinition[] = actions.map((action) => {
    const standard = STANDARD_ACTION_LABELS[action as PermissionAction];
    const actionLabel = standard ?? action;
    return {
      key: `${object}:${action}`,
      label: standard ? `${actionLabel} ${label.toLowerCase()}` : `${actionLabel} (${label.toLowerCase()})`,
    };
  });
  // `<obj>:scope:all` is the opt-in cross-owner grant. Without it a user with
  // read/update/delete can only act on rows they own (see routes/leads scopeFor).
  if (opts.scopeAll) {
    permissions.push({
      key: `${object}:scope:all`,
      label: `See all ${label.toLowerCase()} (not only their own)`,
      description: `Without this grant, the user can only read/edit ${label.toLowerCase()} they own. Grant to managers and admins who need cross-team visibility.`,
    });
  }
  return { key: object, label, permissions };
}

// ---------------------------------------------------------------------------
// Permission Catalog — flat list of objects (~65 entries)
// ---------------------------------------------------------------------------

export const PERMISSION_CATALOG_OBJECTS: ObjectDefinition[] = [
  // ── Workspace settings ────────────────────────────────────────────────
  objectPermissions('general',       'General Settings',     ['read', 'update']),
  {
    key: 'team',
    label: 'Team Members',
    permissions: [
      { key: 'team:read',            label: 'View team members' },
      { key: 'team:create',          label: 'Invite team members' },
      { key: 'team:update',          label: 'Edit team members' },
      { key: 'team:delete',          label: 'Remove team members' },
      {
        key: 'team:invite_external',
        label: 'Invite external guests',
        description: 'Invite outside collaborators (clients, freelancers, vendors) into specific channels. Guests are scoped to invited channels and do not consume a paid seat.',
      },
    ],
  },
  objectPermissions('working-hours', 'Working Hours',        ['edit-self']),
  objectPermissions('teams',         'Teams & Groups',       ['read', 'create', 'update', 'delete']),
  objectPermissions('roles',         'Roles & Permissions',  ['read', 'create', 'update', 'delete']),
  objectPermissions('apikeys',       'API Keys',             ['read', 'create', 'delete']),
  objectPermissions('billing',       'Billing',              ['read', 'manage']),

  // ── CRM ───────────────────────────────────────────────────────────────
  // `<obj>:scope:all` is an OPT-IN elevated grant — without it, a user with
  // `<obj>:read`/`update`/`delete` can only act on rows they own. Wildcards
  // (`*`, `<obj>:*`) cover it via the standard matcher; managers/admins get
  // it explicitly. Today only `customers` is enforced server-side; the
  // contacts/leads grants are pre-emptive so the model stays consistent.
  {
    key: 'leads',
    label: 'Leads',
    permissions: [
      { key: 'leads:read',      label: 'View leads' },
      { key: 'leads:create',    label: 'Create leads' },
      { key: 'leads:update',    label: 'Edit leads' },
      { key: 'leads:delete',    label: 'Delete leads' },
      {
        key: 'leads:scope:all',
        label: 'See all leads (not only their own)',
        description: "Without this grant, the user can only read/edit leads they own. Grant to managers and sales ops who need cross-team visibility.",
      },
    ],
  },
  {
    key: 'contacts',
    label: 'Contacts',
    permissions: [
      { key: 'contacts:read',      label: 'View contacts' },
      { key: 'contacts:create',    label: 'Create contacts' },
      { key: 'contacts:update',    label: 'Edit contacts' },
      { key: 'contacts:delete',    label: 'Delete contacts' },
      {
        key: 'contacts:scope:all',
        label: 'See all contacts (not only their own)',
        description: "Without this grant, the user can only read/edit contacts they own.",
      },
    ],
  },
  // ── Companies + People (Companies/People refactor) ────────────────────
  // These are the new identity-layer surfaces. During the transition the
  // `customers`/`contacts` keys above stay valid — system roles include both
  // sets so existing assignments keep working until the legacy code path is
  // removed in Phase 11 cleanup.
  {
    key: 'people',
    label: 'People',
    permissions: [
      { key: 'people:read',      label: 'View people' },
      { key: 'people:create',    label: 'Create people' },
      { key: 'people:update',    label: 'Edit people' },
      { key: 'people:delete',    label: 'Delete people' },
      {
        key: 'people:scope:all',
        label: 'See all people (not only their own)',
        description: "Without this grant, the user can only read/edit people they own.",
      },
    ],
  },
  objectPermissions('opportunities', 'Opportunities', ['read', 'create', 'update', 'delete'], { scopeAll: true }),
  objectPermissions('activities',    'Activities',    ['read', 'create', 'update', 'delete'], { scopeAll: true }),
  objectPermissions('pipelines',     'Pipelines',            ['read', 'create', 'update', 'delete', 'manage']),
  objectPermissions('quotes',        'Quotes'),
  objectPermissions('telephony',     'Phone Numbers & Porting', ['read', 'manage']),

  // ── Inventory / Commerce / Parcel — share several merged objects ──────
  objectPermissions('products',      'Products'),
  objectPermissions('inventory',     'Inventory',            ['read', 'update', 'manage']),
  objectPermissions('orders',        'Orders'),
  objectPermissions('picklists',     'Pick Lists'),
  objectPermissions('locations',     'Locations'),
  objectPermissions('warehouses',    'Warehouses',           ['read', 'create', 'update', 'delete', 'manage']),
  objectPermissions('suppliers',     'Suppliers'),
  {
    key: 'customers',
    label: 'Customers',
    permissions: [
      { key: 'customers:read',      label: 'View customers' },
      { key: 'customers:create',    label: 'Create customers' },
      { key: 'customers:update',    label: 'Edit customers' },
      { key: 'customers:delete',    label: 'Delete customers' },
      {
        key: 'customers:scope:all',
        label: 'See all customers (not only their own)',
        description: "Without this grant, the user can only read/edit customers they own. Grant to managers, admins, and sales ops who need cross-team visibility.",
      },
    ],
  },
  // Companies — new identity-layer surface (Companies/People refactor).
  // The `customers` key above stays valid in parallel during the transition.
  {
    key: 'companies',
    label: 'Companies',
    permissions: [
      { key: 'companies:read',      label: 'View companies' },
      { key: 'companies:create',    label: 'Create companies' },
      { key: 'companies:update',    label: 'Edit companies' },
      { key: 'companies:delete',    label: 'Delete companies' },
      {
        key: 'companies:scope:all',
        label: 'See all companies (not only their own)',
        description: "Without this grant, the user can only read/edit companies they own.",
      },
    ],
  },
  objectPermissions('lists',         'Lists'),
  objectPermissions('discounts',     'Discounts'),
  objectPermissions('categories',    'Categories'),
  objectPermissions('websites',      'Websites',             ['read', 'create', 'update', 'delete', 'manage']),

  // ── Accounting (WeldBooks) ────────────────────────────────────────────
  objectPermissions('entities',      'Legal Entities',       ['read', 'create', 'update', 'delete', 'manage']),
  objectPermissions('invoices',      'Invoices'),
  objectPermissions('bills',         'Bills'),
  objectPermissions('journal',       'Journal Entries',      ['read', 'create', 'update', 'delete', 'manage']),
  objectPermissions('accounts',      'Accounts',             ['read', 'create', 'update', 'delete', 'manage']),
  objectPermissions('banking',       'Banking',              ['read', 'create', 'update', 'manage']),
  objectPermissions('reports',       'Reports',              ['read', 'manage']),

  // ── Helpdesk (WeldDesk) ───────────────────────────────────────────────
  objectPermissions('tickets',       'Tickets'),
  objectPermissions('conversations', 'Conversations'),
  objectPermissions('articles',      'Knowledge Base Articles'),
  objectPermissions('agents',        'Agents',               ['read', 'create', 'update', 'delete', 'manage']),
  objectPermissions('departments',   'Departments',          ['read', 'create', 'update', 'delete', 'manage']),
  objectPermissions('slas',          'SLAs',                 ['read', 'create', 'update', 'delete', 'manage']),
  objectPermissions('settings',      'Module Settings',      ['read', 'update', 'manage']),
  // WeldDesk v2 (Intercom rebuild — see .claude/welddesk-intercom-plan.md).
  // `inboxes` = team inboxes (desk_teams, successor of departments);
  // `helpdesk-workflows` is prefixed to avoid clashing with WeldConnect workflows.
  objectPermissions('inboxes',            'Team Inboxes',    ['read', 'create', 'update', 'delete', 'manage']),
  objectPermissions('helpdesk-workflows', 'Helpdesk Workflows'),
  objectPermissions('macros',             'Macros'),
  objectPermissions('news',               'News'),
  objectPermissions('helpdesk-ai',        'Helpdesk AI Agent', ['read', 'update', 'manage']),

  // ── Knowledge Base (WeldKnow) ─────────────────────────────────────────
  objectPermissions('knowledge',     'Knowledge Base'),

  // ── Parcel ────────────────────────────────────────────────────────────
  objectPermissions('parcels',       'Parcels'),
  objectPermissions('carriers',      'Carriers',             ['read', 'create', 'update', 'delete', 'manage']),
  objectPermissions('boxes',         'Box Templates'),
  objectPermissions('returns',       'Returns'),
  objectPermissions('pickups',       'Pickups'),
  objectPermissions('webhooks',      'Webhooks',             ['read', 'create', 'update', 'delete', 'manage']),

  // ── Projects (WeldFlow) ───────────────────────────────────────────────
  // `projects:scope:all` is the cross-project god-view. Without it a user only
  // sees projects they manage (projectManagerId) or are an active member of —
  // see apps/workers/app-api/src/routes/projects GET /. Owners (`*`) and admins
  // (`weldflow:*` + explicit grant below) have it.
  objectPermissions('projects',      'Projects',  ['read', 'create', 'update', 'delete'], { scopeAll: true }),
  objectPermissions('tasks',         'Tasks'),
  objectPermissions('milestones',    'Milestones'),
  objectPermissions('time',          'Time Entries'),
  objectPermissions('files',         'Files'),

  // ── Mail / Chat / Social — share `messages`, `accounts`, `campaigns` ──
  objectPermissions('messages',      'Messages'),
  objectPermissions('templates',     'Templates'),
  objectPermissions('campaigns',     'Campaigns'),
  objectPermissions('channels',      'Channels'),
  objectPermissions('posts',         'Posts'),
  objectPermissions('analytics',     'Analytics',            ['read']),

  // ── Hosting (WeldHost) ────────────────────────────────────────────────
  objectPermissions('domains',       'Domains'),
  objectPermissions('dns',           'DNS Records'),
  objectPermissions('email',         'Email Forwarding'),
  objectPermissions('transfers',     'Domain Transfers'),

  // ── Integrations (WeldConnect) ────────────────────────────────────────
  // 'integrations' uses non-standard sub-keyed actions like
  // 'integrations:github:manage'. We surface the single known one;
  // future integrations should add new entries here.
  {
    key: 'integrations',
    label: 'Integrations',
    permissions: [
      {
        key: 'integrations:github:manage',
        label: 'Manage GitHub integration (install, disconnect, configure sync)',
      },
    ],
  },

  // ── Drive ─────────────────────────────────────────────────────────────
  objectPermissions('folders',       'Folders'),

  // ── Calendar ──────────────────────────────────────────────────────────
  objectPermissions('events',        'Events',               ['read', 'create', 'update', 'delete'], { scopeAll: true }),
  objectPermissions('calendars',     'Calendars',            ['read', 'create', 'update', 'delete', 'manage'], { scopeAll: true }),
  objectPermissions('bookings',      'Bookings',             ['read', 'create', 'update', 'delete'], { scopeAll: true }),

  // ── Meet ──────────────────────────────────────────────────────────────
  objectPermissions('meetings',      'Meetings',             ['read', 'create', 'update', 'delete'], { scopeAll: true }),
  objectPermissions('sessions',      'Sessions'),
  objectPermissions('recordings',    'Recordings',           ['read', 'delete']),

  // ── WeldData (lead database) ──────────────────────────────────────────
  // `prospects` covers searching the external database and managing saved
  // leads + their lists. Converting a saved lead also requires the CRM
  // `people:create` / `companies:create` grants (enforced in the service).
  objectPermissions('prospects',     'Lead Database'),

  // ── WeldApps (user-created apps) ──────────────────────────────────────
  // `manage` covers installing/uninstalling apps and approving scope
  // grants; `develop` covers creating apps + deploying versions to the
  // authoring workspace; `publish` covers submitting to the public store.
  {
    key: 'weldapps',
    label: 'WeldApps',
    permissions: [
      { key: 'weldapps:read',    label: 'View user-created apps' },
      {
        key: 'weldapps:develop',
        label: 'Develop apps',
        description: 'Create user-created apps and deploy new versions to this workspace.',
      },
      {
        key: 'weldapps:publish',
        label: 'Publish apps to the public store',
        description: 'Submit apps for review and manage their public App Store listing.',
      },
      {
        key: 'weldapps:manage',
        label: 'Install & manage apps',
        description: 'Install/uninstall user-created apps and approve the API scopes they request.',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// System Role Definitions
//
// ADMIN / MEMBER / VIEWER are derived from the previous 3-segment role
// definitions via `migratePermissionKeys`. This guarantees semantic
// equivalence with the pre-refactor roles. OWNER stays `['*']`.
// ---------------------------------------------------------------------------

const LEGACY_ADMIN_PERMISSIONS: string[] = [
  // Settings
  'settings:general:read', 'settings:general:update',
  'settings:team:read', 'settings:team:create', 'settings:team:update', 'settings:team:delete',
  'team:invite_external',
  'settings:teams:read', 'settings:teams:create', 'settings:teams:update', 'settings:teams:delete',
  'settings:roles:read', 'settings:roles:create', 'settings:roles:update', 'settings:roles:delete',
  'settings:apikeys:read', 'settings:apikeys:create', 'settings:apikeys:delete',
  'settings:billing:read',
  'settings:working-hours:edit-self',
  // All app modules (full access)
  'weldcrm:*', 'weldstash:*', 'weldbooks:*',
  'welddesk:*', 'weldparcel:*', 'weldflow:*', 'weldmail:*', 'weldhost:*',
  'weldchat:*', 'weldconnect:*', 'welddrive:*', 'weldcalendar:*', 'weldmeet:*', 'weldsocial:*',
  // Cross-owner scope grants — admins see and edit all rows, not just their own
  'customers:scope:all', 'contacts:scope:all', 'leads:scope:all',
  'opportunities:scope:all', 'activities:scope:all',
  // Calendar + Meet cross-owner grants — admins see all calendars/events/meetings
  'calendars:scope:all', 'events:scope:all', 'bookings:scope:all', 'meetings:scope:all',
  // WeldFlow cross-project grant — admins see every project, not only their own.
  // (`weldflow:*` already covers this; listed explicitly so the model is clear.)
  'projects:scope:all',
  // Companies + People (new identity surfaces) — admin sees all
  'companies:read', 'companies:create', 'companies:update', 'companies:delete', 'companies:scope:all',
  'people:read', 'people:create', 'people:update', 'people:delete', 'people:scope:all',
  'lists:read', 'lists:create', 'lists:update', 'lists:delete',
  // WeldData (lead database)
  'prospects:read', 'prospects:create', 'prospects:update', 'prospects:delete',
  // WeldApps (user-created apps) — admins can build, publish, and install
  'weldapps:read', 'weldapps:develop', 'weldapps:publish', 'weldapps:manage',
];

const LEGACY_MEMBER_PERMISSIONS: string[] = [
  // Settings (read-only)
  'settings:general:read', 'settings:team:read', 'settings:teams:read',
  'settings:working-hours:edit-self',
  // WeldCRM
  'weldcrm:leads:read', 'weldcrm:leads:create', 'weldcrm:leads:update',
  'weldcrm:contacts:read', 'weldcrm:contacts:create', 'weldcrm:contacts:update',
  'weldcrm:opportunities:read', 'weldcrm:opportunities:create', 'weldcrm:opportunities:update',
  'weldcrm:activities:read', 'weldcrm:activities:create', 'weldcrm:activities:update',
  'weldcrm:pipelines:read',
  'weldcrm:quotes:read', 'weldcrm:quotes:create', 'weldcrm:quotes:update',
  // Companies + People (Companies/People refactor) — members get base CRUD
  // without scope:all (they can manage rows they own).
  'companies:read', 'companies:create', 'companies:update',
  'people:read', 'people:create', 'people:update',
  'lists:read', 'lists:create', 'lists:update',
  // WeldData (lead database) — members can search, save, and convert
  'prospects:read', 'prospects:create', 'prospects:update',
  // WeldStash
  'weldstash:products:read', 'weldstash:products:create', 'weldstash:products:update',
  'weldstash:inventory:read', 'weldstash:inventory:update',
  'weldstash:orders:read', 'weldstash:orders:create', 'weldstash:orders:update',
  'weldstash:picklists:read', 'weldstash:picklists:create', 'weldstash:picklists:update',
  'weldstash:locations:read',
  'weldstash:warehouses:read',
  'weldstash:suppliers:read',
  // WeldBooks
  'weldbooks:invoices:read', 'weldbooks:invoices:create', 'weldbooks:invoices:update',
  'weldbooks:bills:read', 'weldbooks:bills:create', 'weldbooks:bills:update',
  'weldbooks:journal:read',
  'weldbooks:accounts:read',
  'weldbooks:banking:read',
  'weldbooks:suppliers:read', 'weldbooks:suppliers:create', 'weldbooks:suppliers:update',
  'weldbooks:customers:read', 'weldbooks:customers:create', 'weldbooks:customers:update',
  'weldbooks:reports:read',
  // WeldDesk
  'welddesk:tickets:read', 'welddesk:tickets:create', 'welddesk:tickets:update',
  'welddesk:conversations:read', 'welddesk:conversations:create', 'welddesk:conversations:update',
  'welddesk:articles:read',
  'welddesk:agents:read',
  'welddesk:departments:read',
  'welddesk:slas:read',
  'welddesk:settings:read',
  // WeldDesk v2 objects — members read inboxes/workflows/news, manage macros
  'welddesk:inboxes:read',
  'welddesk:workflows:read',
  'welddesk:macros:read', 'welddesk:macros:create', 'welddesk:macros:update',
  'welddesk:news:read',
  'welddesk:ai:read',
  // WeldParcel
  'weldparcel:orders:read', 'weldparcel:orders:create', 'weldparcel:orders:update',
  'weldparcel:parcels:read', 'weldparcel:parcels:create', 'weldparcel:parcels:update',
  'weldparcel:carriers:read',
  'weldparcel:boxes:read',
  'weldparcel:returns:read', 'weldparcel:returns:create', 'weldparcel:returns:update',
  'weldparcel:pickups:read', 'weldparcel:pickups:create',
  // WeldFlow
  'weldflow:projects:read', 'weldflow:projects:create', 'weldflow:projects:update',
  'weldflow:tasks:read', 'weldflow:tasks:create', 'weldflow:tasks:update',
  'weldflow:milestones:read', 'weldflow:milestones:create', 'weldflow:milestones:update',
  // `time:delete` is the one delete grant members get in WeldFlow: DELETE
  // /api/time-entries/:id is owner-scoped (`eq(t.userId, callerId)`), so this
  // only ever lets a member remove their own entry — never a colleague's.
  'weldflow:time:read', 'weldflow:time:create', 'weldflow:time:update', 'weldflow:time:delete',
  'weldflow:files:read', 'weldflow:files:create',
  // WeldMail
  'weldmail:accounts:read',
  'weldmail:messages:read', 'weldmail:messages:create', 'weldmail:messages:update', 'weldmail:messages:delete',
  'weldmail:templates:read',
  'weldmail:campaigns:read',
  // WeldHost
  'weldhost:domains:read',
  'weldhost:dns:read',
  'weldhost:email:read',
  // WeldChat
  'weldchat:channels:read', 'weldchat:channels:create',
  'weldchat:messages:read', 'weldchat:messages:create', 'weldchat:messages:update', 'weldchat:messages:delete',
  'weldchat:settings:read',
  // WeldMeet
  'weldmeet:meetings:read', 'weldmeet:meetings:create', 'weldmeet:meetings:update',
  'weldmeet:sessions:read', 'weldmeet:sessions:create',
  'weldmeet:recordings:read',
  // WeldConnect
  'weldconnect:tasks:read', 'weldconnect:tasks:create', 'weldconnect:tasks:update', 'weldconnect:tasks:delete',
  // WeldDrive
  'welddrive:files:read', 'welddrive:files:create', 'welddrive:files:update',
  'welddrive:folders:read', 'welddrive:folders:create', 'welddrive:folders:update',
  // WeldCalendar
  'weldcalendar:events:read', 'weldcalendar:events:create', 'weldcalendar:events:update',
  'weldcalendar:calendars:read',
  'weldcalendar:bookings:read', 'weldcalendar:bookings:create', 'weldcalendar:bookings:update',
  // WeldSocial
  'weldsocial:accounts:read',
  'weldsocial:posts:read', 'weldsocial:posts:create', 'weldsocial:posts:update',
  'weldsocial:campaigns:read',
  'weldsocial:analytics:read',
  // WeldApps (user-created apps) — members can use installed apps
  'weldapps:read',
];

const LEGACY_VIEWER_PERMISSIONS: string[] = [
  'settings:general:read', 'settings:team:read', 'settings:teams:read',
  'weldcrm:*:read', 'weldstash:*:read', 'weldbooks:*:read',
  'welddesk:*:read', 'weldparcel:*:read', 'weldflow:*:read', 'weldmail:*:read',
  'weldhost:*:read', 'weldchat:*:read', 'weldconnect:*:read', 'welddrive:*:read',
  'weldcalendar:*:read', 'weldmeet:*:read', 'weldsocial:*:read',
  // WeldData (lead database) — read-only
  'prospects:read',
  // WeldApps (user-created apps) — read-only
  'weldapps:read',
];

export const SYSTEM_ROLES: Record<string, SystemRoleDefinition> = {
  OWNER: {
    name: 'Owner',
    description: 'Full access to all workspace settings and data',
    isSystem: true,
    permissions: ['*'],
  },
  ADMIN: {
    name: 'Admin',
    description: 'Can manage team members, roles, and most settings',
    isSystem: true,
    permissions: migratePermissionKeys(LEGACY_ADMIN_PERMISSIONS),
  },
  MEMBER: {
    name: 'Member',
    description: 'Standard access to assigned apps and features',
    isSystem: true,
    permissions: migratePermissionKeys(LEGACY_MEMBER_PERMISSIONS),
  },
  VIEWER: {
    name: 'Viewer',
    description: 'Read-only access to workspace data',
    isSystem: true,
    permissions: migratePermissionKeys(LEGACY_VIEWER_PERMISSIONS),
  },
};

// ---------------------------------------------------------------------------
// Flat permission catalog (alternative format, keyed by object key)
// ---------------------------------------------------------------------------

export const PERMISSION_CATALOG = {
  objects: PERMISSION_CATALOG_OBJECTS.map((object) => ({
    object: object.key,
    objectName: object.label,
    permissions: object.permissions.map((p) => ({
      code: p.key,
      name: p.label,
      description: p.description,
      action: p.key.split(':').slice(1).join(':') || 'read',
      isGranted: false,
    })),
  })),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get all concrete permission keys from the catalog. */
export function getAllPermissionKeys(): string[] {
  const keys: string[] = [];
  for (const object of PERMISSION_CATALOG_OBJECTS) {
    for (const permission of object.permissions) {
      keys.push(permission.key);
    }
  }
  return keys;
}

/**
 * Map of route prefix → old app permission prefix.
 *
 * Retained for legacy callers that still use the old app-based grouping
 * (e.g. routing / sidebar code that hasn't moved to the per-object model
 * yet). New code should rely on `APP_TO_OBJECTS` from migration-map.ts
 * combined with `hasAnyObjectAccess()` instead.
 *
 * @deprecated will be removed once all consumers migrate to object-based
 * gating.
 */
export const ROUTE_TO_APP: Record<string, string> = {
  crm: 'weldcrm',
  wms: 'weldstash',
  accounting: 'weldbooks',
  helpdesk: 'welddesk',
  parcel: 'weldparcel',
  projects: 'weldflow',
  mail: 'weldmail',
  host: 'weldhost',
  chat: 'weldchat',
  task: 'weldconnect',
  drive: 'welddrive',
  calendar: 'weldcalendar',
  meet: 'weldmeet',
  social: 'weldsocial',
};
