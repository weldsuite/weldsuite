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
  {
    key: 'sso',
    label: 'Single Sign-On',
    permissions: [
      { key: 'sso:read', label: 'View single sign-on settings' },
      {
        key: 'sso:manage',
        label: 'Configure single sign-on',
        description: 'Verify the company domain, connect the identity provider and switch SSO on or off. Buying the SSO add-on also needs Manage billing.',
      },
    ],
  },

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
  // `create`/`delete` cover creating and soft-deleting stock buckets
  // (POST/DELETE /api/inventory). They are listed explicitly because `manage`
  // is a peer action, not a superset — the matcher in engine.ts only widens on
  // a literal `*`, so without these keys the routes are grantable to nobody
  // but Owner.
  objectPermissions('inventory',     'Inventory',            ['read', 'create', 'update', 'delete', 'manage']),
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
  objectPermissions('banking',       'Banking',              ['read', 'create', 'update', 'delete', 'manage']),
  objectPermissions('reports',       'Reports',              ['read', 'manage']),
  // Sales tax agencies, rates, returns, exemption certificates and 1099s.
  {
    key: 'taxes',
    label: 'Taxes',
    permissions: [
      { key: 'taxes:read', label: 'View sales tax, tax returns and 1099s' },
      { key: 'taxes:create', label: 'Create agencies, rates, certificates and returns' },
      { key: 'taxes:update', label: 'Edit agencies, rates, certificates and returns' },
      { key: 'taxes:delete', label: 'Delete agencies, rates and certificates' },
      { key: 'taxes:file', label: 'Mark tax returns and 1099s filed and record their payment' },
    ],
  },
  // Revealing a full TIN, SSN or bank account number. Kept apart from every
  // read grant (like `employees:sensitive`); each reveal is logged.
  {
    key: 'tax_ids',
    label: 'Tax IDs',
    permissions: [
      {
        key: 'tax_ids:reveal',
        label: 'Reveal full TINs, SSNs and bank account numbers',
        description: 'Every reveal is recorded in the tax ID reveal log.',
      },
    ],
  },

  // ── Helpdesk (WeldDesk) ───────────────────────────────────────────────
  objectPermissions('tickets',       'Tickets'),
  objectPermissions('conversations', 'Conversations'),
  objectPermissions('articles',      'Knowledge Base Articles'),
  objectPermissions('agents',        'Agents',               ['read', 'create', 'update', 'delete', 'manage']),
  objectPermissions('departments',   'Departments',          ['read', 'create', 'update', 'delete', 'manage']),
  objectPermissions('slas',          'SLAs',                 ['read', 'create', 'update', 'delete', 'manage']),
  objectPermissions('settings',      'Module Settings',      ['read', 'update', 'manage']),

  // ── Knowledge Base (WeldKnow) ─────────────────────────────────────────
  // Inside WeldKnow, teamspace membership decides who reads and writes which
  // pages. `knowledge:manage` lets an admin see every teamspace (private ones
  // too) and fix its settings and members; reading a closed or private
  // teamspace still takes joining it. Personal spaces stay sealed.
  objectPermissions('knowledge',     'Knowledge Base',       ['read', 'create', 'update', 'delete', 'manage']),

  // ── Spreadsheets (WeldSheets) ─────────────────────────────────────────
  // These open the app. Who may edit a given spreadsheet is its own sharing
  // (owner, editor, commenter, viewer); `sheets:manage` lets an admin see
  // every spreadsheet and fix its sharing.
  {
    key: 'sheets',
    label: 'Spreadsheets (WeldSheets)',
    permissions: [
      { key: 'sheets:read', label: 'Open spreadsheets', description: 'Spreadsheets this person owns or that are shared with them.' },
      { key: 'sheets:create', label: 'Create spreadsheets' },
      { key: 'sheets:update', label: 'Edit spreadsheets' },
      {
        key: 'sheets:comment',
        label: 'Comment on spreadsheets',
        description: 'Comment on spreadsheets shared with them to view, without editing them.',
      },
      { key: 'sheets:delete', label: 'Delete spreadsheets' },
      { key: 'sheets:share', label: 'Share spreadsheets' },
      {
        key: 'sheets:manage',
        label: 'Administer spreadsheets',
        description: "See every spreadsheet in the workspace and change who it is shared with.",
      },
    ],
  },

  // ── Documents (WeldDocs) ──────────────────────────────────────────────
  // These open the app. Who may edit a given document is its own sharing
  // (owner, editor, commenter, viewer); `docs:manage` lets an admin see
  // every document and fix its sharing.
  {
    key: 'docs',
    label: 'Documents (WeldDocs)',
    permissions: [
      { key: 'docs:read', label: 'Open documents', description: 'Documents this person owns or that are shared with them.' },
      { key: 'docs:create', label: 'Create documents' },
      { key: 'docs:update', label: 'Edit documents' },
      {
        key: 'docs:comment',
        label: 'Comment on documents',
        description: 'Comment on documents shared with them to view, without editing them.',
      },
      { key: 'docs:delete', label: 'Delete documents' },
      { key: 'docs:share', label: 'Share documents' },
      {
        key: 'docs:manage',
        label: 'Administer documents',
        description: "See every document in the workspace and change who it is shared with.",
      },
    ],
  },

  // ── E-signatures (WeldSign) ───────────────────────────────────────────
  // Without `sign_envelopes:manage` a person sees the envelopes they sent and
  // the ones they are a recipient of; with it, every envelope in the
  // workspace and the WeldSign settings.
  {
    key: 'sign_envelopes',
    label: 'Signature requests (WeldSign)',
    permissions: [
      { key: 'sign_envelopes:read', label: 'View signature requests', description: 'Requests this person sent or is a recipient of.' },
      { key: 'sign_envelopes:create', label: 'Create signature requests' },
      { key: 'sign_envelopes:update', label: 'Edit draft signature requests' },
      { key: 'sign_envelopes:delete', label: 'Delete signature requests' },
      { key: 'sign_envelopes:send', label: 'Send signature requests', description: 'Counts towards the monthly WeldSign limit of the plan.' },
      { key: 'sign_envelopes:void', label: 'Void sent signature requests' },
      {
        key: 'sign_envelopes:manage',
        label: 'Administer WeldSign',
        description: 'See every signature request in the workspace and change the WeldSign settings.',
      },
    ],
  },
  objectPermissions('sign_templates', 'Signature templates'),

  // ── Product analytics (WeldPanel) ─────────────────────────────────────
  // Recordings and people are kept apart from reports: a recording shows what
  // a visitor saw and did, and a profile carries their email.
  objectPermissions('panel_projects', 'Tracked projects (WeldPanel)', ['read', 'create', 'update', 'delete', 'manage']),
  objectPermissions('panel_reports', 'Analytics reports and dashboards'),
  {
    key: 'panel_recordings',
    label: 'Session recordings (WeldPanel)',
    permissions: [
      { key: 'panel_recordings:read', label: 'Watch session recordings' },
      { key: 'panel_recordings:delete', label: 'Delete session recordings' },
    ],
  },
  {
    key: 'panel_people',
    label: 'Tracked users (WeldPanel)',
    permissions: [
      { key: 'panel_people:read', label: 'View tracked user profiles', description: 'Profiles can include the user\'s email and name.' },
      { key: 'panel_people:delete', label: 'Erase tracked users', description: 'Removes the profile, its events and its recordings (GDPR erasure).' },
    ],
  },

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

  // ── WeldAds (paid advertising) ────────────────────────────────────────
  objectPermissions('ad_accounts',   'Ad Accounts',          ['read', 'update']),
  objectPermissions('ad_campaigns',  'Ad Campaigns',         ['read', 'create', 'update']),

  // ── Hosting (WeldHost) ────────────────────────────────────────────────
  objectPermissions('domains',       'Domains'),
  objectPermissions('dns',           'DNS Records'),
  objectPermissions('email',         'Email Forwarding'),
  objectPermissions('transfers',     'Domain Transfers'),

  // ── WeldConnect (workspace automation) ────────────────────────────────
  // Prefixed where needed so mail `templates` / shared objects don't collide.
  objectPermissions('workflows', 'Workflows'),
  objectPermissions('workflow-executions', 'Workflow Executions', ['read', 'update']),
  objectPermissions('workflow-templates', 'Workflow Templates'),
  objectPermissions('workflow-variables', 'Workflow Variables'),
  objectPermissions('workflow-webhooks', 'Workflow Webhooks'),
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
      { key: 'integrations:read', label: 'View integrations' },
      { key: 'integrations:create', label: 'Connect integrations' },
      { key: 'integrations:update', label: 'Edit integrations' },
      { key: 'integrations:delete', label: 'Disconnect integrations' },
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

  // ── WeldAgent (workspace AI agents) ───────────────────────────────────
  // Distinct from helpdesk `agents` (human support roster). `use` covers
  // chatting with / manually running an agent; CRUD/manage covers the builder.
  {
    key: 'weldagent',
    label: 'WeldAgent',
    permissions: [
      { key: 'weldagent:read',   label: 'View workspace AI agents' },
      { key: 'weldagent:create', label: 'Create workspace AI agents' },
      { key: 'weldagent:update', label: 'Edit workspace AI agents' },
      { key: 'weldagent:delete', label: 'Delete workspace AI agents' },
      {
        key: 'weldagent:use',
        label: 'Chat with and run AI agents',
        description: 'Send messages to workspace agents and trigger manual runs. Tool actions are still limited by each agent’s own permission grants.',
      },
      {
        key: 'weldagent:manage',
        label: 'Manage AI agents',
        description: 'Full control over workspace AI agents, including activating event listeners and assigning platform permission grants.',
      },
    ],
  },

  // ── Agent computer (grants assigned to WeldAgents, not human roles) ───
  // Exposed via GET /api/weldagent/agents/grantable-permissions so builders
  // can unlock Cloudflare Sandbox / Browser Run tools on a bot.
  {
    key: 'computer',
    label: 'Agent computer',
    permissions: [
      {
        key: 'computer:use',
        label: 'Use workspace computer',
        description: 'Shell, files, and code interpreter on the workspace’s Cloudflare Sandbox.',
      },
      {
        key: 'browser:use',
        label: 'Use cloud browser',
        description: 'Navigate and automate pages with Cloudflare Browser Run.',
      },
    ],
  },

  // ── WeldPass (secret management) ──────────────────────────────────────
  // `read` lists keys and metadata only. Seeing a value needs `reveal`, so a
  // developer can manage the inventory without ever reading production
  // credentials. `sync` pushes an environment to Cloudflare/Vercel.
  {
    key: 'secrets',
    label: 'Secrets (WeldPass)',
    permissions: [
      { key: 'secrets:read',   label: 'View secret names and metadata' },
      {
        key: 'secrets:reveal',
        label: 'Reveal secret values',
        description: 'Decrypt and read stored values. Every reveal is written to the WeldPass audit trail.',
      },
      { key: 'secrets:create', label: 'Create secrets and vault projects' },
      { key: 'secrets:update', label: 'Edit secrets' },
      { key: 'secrets:delete', label: 'Delete secrets' },
      {
        key: 'secrets:sync',
        label: 'Sync secrets to deploy targets',
        description: 'Push a vault environment to Cloudflare Workers, Cloudflare Pages or Vercel.',
      },
      {
        key: 'secrets:manage',
        label: 'Manage vaults and provider credentials',
        description: 'Configure environments, sync targets, and the Cloudflare/Vercel API tokens WeldPass deploys with.',
      },
    ],
  },
  // ── WeldPass password manager ─────────────────────────────────────────
  // Deliberately thin. These decide who may use the password manager at all;
  // what someone can do inside a vault is their role *on that vault* (viewer,
  // editor, manager), not a workspace permission. `passwords:manage` is for
  // recovering a shared vault nobody manages any more — it does not open
  // anyone's personal vault, and reading a shared vault still takes joining it.
  {
    key: 'passwords',
    label: 'Passwords (WeldPass)',
    permissions: [
      {
        key: 'passwords:use',
        label: 'Use the password manager',
        description: 'A personal vault, plus the shared vaults this person is added to.',
      },
      { key: 'passwords:create', label: 'Create shared vaults' },
      {
        key: 'passwords:manage',
        label: 'Administer shared vaults',
        description:
          'See every shared vault and change who is in it. Does not open personal vaults; reading a shared vault still requires being a member, and joining one is recorded.',
      },
    ],
  },
  // ── WeldReach (cold email outreach) ───────────────────────────────────
  // Mailboxes cost money (a monthly Stripe line per inbox) and domains carry
  // the sender reputation, so `reach_mailboxes` writes are ADMIN by default.
  // The module itself is on request only: none of this works until WeldSuite
  // staff approve the workspace (docs/plans/weldreach.md).
  objectPermissions('reach_campaigns', 'Outreach campaigns'),
  objectPermissions('reach_prospects', 'Outreach prospects'),
  {
    key: 'reach_inbox',
    label: 'Outreach replies',
    permissions: [
      { key: 'reach_inbox:read', label: 'View replies' },
      { key: 'reach_inbox:update', label: 'Label and handle replies' },
      { key: 'reach_inbox:reply', label: 'Answer replies', description: 'Send an answer from the outreach mailbox the prospect replied to.' },
    ],
  },
  {
    key: 'reach_mailboxes',
    label: 'Outreach mailboxes and domains',
    permissions: [
      { key: 'reach_mailboxes:read', label: 'View outreach mailboxes and domains' },
      {
        key: 'reach_mailboxes:create',
        label: 'Create outreach mailboxes and connect domains',
        description: 'Each mailbox is billed monthly to the workspace.',
      },
      { key: 'reach_mailboxes:update', label: 'Edit, pause and resume outreach mailboxes' },
      { key: 'reach_mailboxes:delete', label: 'Delete outreach mailboxes and disconnect domains' },
    ],
  },
  objectPermissions('reach_settings', 'Outreach settings', ['read', 'update']),
  // ── WeldHR (employee operations + My HR) ──────────────────────────────
  // HR data is need-to-know: by default MEMBER gets only `employees:self` (My
  // HR, their own record) and VIEWER gets nothing. Approving and the team view
  // are for ADMIN or a custom role.
  // `employees:sensitive` is kept apart from `employees:read` (same idea as
  // secrets:read vs secrets:reveal) so a team lead can coach and schedule
  // without seeing pay, national ids or home addresses.
  {
    key: 'employees',
    label: 'Employees (WeldHR)',
    permissions: [
      { key: 'employees:read', label: 'View employees, teams and client assignments' },
      { key: 'employees:create', label: 'Add employees' },
      { key: 'employees:update', label: 'Edit employees, assignments and onboarding' },
      { key: 'employees:delete', label: 'Delete employees' },
      {
        key: 'employees:sensitive',
        label: 'View and edit sensitive employee data',
        description: 'Date of birth, national and tax ids, home address, emergency contact, bank details and pay. Every read is written to the WeldHR audit trail.',
      },
      {
        key: 'employees:manage',
        label: 'Manage WeldHR settings',
        description: 'Departments, checklist templates, evaluation forms, KPI definitions, leave types and what employees may do themselves in My HR.',
      },
      {
        key: 'employees:self',
        label: 'Use My HR',
        description: 'Their own employee record only: profile, leave, expense declarations, sick reports, attendance, onboarding tasks, coaching, evaluations, payslips, and their own tax and bank details. Requires being linked to an employee.',
      },
    ],
  },
  objectPermissions('attendance', 'Attendance', ['read', 'create', 'update', 'delete', 'approve']),
  objectPermissions('leave', 'Leave', ['read', 'create', 'update', 'delete', 'approve']),
  objectPermissions('declarations', 'Expense declarations', ['read', 'create', 'update', 'delete', 'approve']),
  // Sick reports are kept apart from leave: who is ill is not for everyone who
  // approves holidays. Employees report for themselves through employees:self.
  objectPermissions('absences', 'Sick reports'),
  objectPermissions('coaching', 'Coaching logs'),
  objectPermissions('evaluations', 'Evaluations and KPIs'),
  // Announcements from HR to employees (My HR and the WeldHR app). Employees
  // read the ones meant for them through employees:self.
  objectPermissions('announcements', 'Announcements'),
  // Payroll is kept apart from employees:sensitive: running pay is not the same
  // as reading national ids, and preparing a run is not approving it (four
  // eyes). Employees see their own payslips through employees:self.
  {
    key: 'payroll',
    label: 'Payroll (WeldHR)',
    permissions: [
      {
        key: 'payroll:read',
        label: 'View pay runs, payslips and filings',
        description: "Every employee's pay, payslips, totals and tax filings.",
      },
      {
        key: 'payroll:prepare',
        label: 'Prepare payroll',
        description: 'Compensation, pay components, tax settings and bank details; create and calculate pay runs.',
      },
      {
        key: 'payroll:approve',
        label: 'Approve and pay payroll',
        description: 'Approve calculated pay runs, download payment files and mark runs paid.',
      },
      {
        key: 'payroll:manage',
        label: 'Manage payroll settings and filings',
        description: 'Employers, pay schedules, the WeldBooks link, and submitting or recording tax filings.',
      },
    ],
  },
  // ── WeldObjects (user-defined custom objects) ─────────────────────────
  // Only the MODULE-level keys live here. The per-object keys
  // (`weldobjects:<slug>:read` etc.) are generated at runtime from the
  // tenant's `custom_objects` rows — see ./custom-objects.ts — and merged
  // into the role editor by GET /api/roles/permission-catalog.
  {
    key: 'weldobjects',
    label: 'WeldObjects',
    permissions: [
      { key: 'weldobjects:read', label: 'View custom objects' },
      {
        key: 'weldobjects:manage',
        label: 'Define & manage custom objects',
        description:
          'Create, edit and delete custom object types, their fields and their relationships. Deleting an object type deletes every record in it — grant this like a settings permission, not a data one.',
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
  // Single sign-on configuration (buying the add-on still takes billing:manage)
  'sso:read', 'sso:manage',
  // All app modules (full access)
  'weldcrm:*', 'weldstash:*', 'weldbooks:*',
  'welddesk:*', 'weldparcel:*', 'weldflow:*', 'weldmail:*', 'weldhost:*',
  'weldchat:*', 'weldconnect:*', 'welddrive:*', 'weldcalendar:*', 'weldmeet:*', 'weldsocial:*', 'weldads:*',
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
  // WeldAgent (workspace AI agents) — admins fully manage
  'weldagent:read', 'weldagent:create', 'weldagent:update', 'weldagent:delete', 'weldagent:use', 'weldagent:manage',
  // WeldObjects — admins define object types AND get full cross-owner access
  // to every object's records. The `weldobjects:*:<action>` middle wildcard
  // matches any slug without matching the 2-segment `weldobjects:manage`.
  'weldobjects:read', 'weldobjects:manage',
  'weldobjects:*:read', 'weldobjects:*:create', 'weldobjects:*:update', 'weldobjects:*:delete',
  'weldobjects:*:scope:all',
  // WeldPass (secret management) — admins run the vaults
  'secrets:read', 'secrets:reveal', 'secrets:create', 'secrets:update',
  'secrets:delete', 'secrets:sync', 'secrets:manage',
  // WeldPass password manager — admins can also recover unmanaged shared vaults
  'passwords:use', 'passwords:create', 'passwords:manage',
  // WeldHR — admins run HR, including the sensitive block
  'employees:read', 'employees:create', 'employees:update', 'employees:delete',
  'employees:sensitive', 'employees:manage', 'employees:self',
  'attendance:read', 'attendance:create', 'attendance:update', 'attendance:delete', 'attendance:approve',
  'leave:read', 'leave:create', 'leave:update', 'leave:delete', 'leave:approve',
  'declarations:read', 'declarations:create', 'declarations:update', 'declarations:delete', 'declarations:approve',
  'absences:read', 'absences:create', 'absences:update', 'absences:delete',
  'coaching:read', 'coaching:create', 'coaching:update', 'coaching:delete',
  'evaluations:read', 'evaluations:create', 'evaluations:update', 'evaluations:delete',
  'announcements:read', 'announcements:create', 'announcements:update', 'announcements:delete',
  // WeldHR payroll
  'payroll:read', 'payroll:prepare', 'payroll:approve', 'payroll:manage',
  // WeldKnow — admins also see and fix every teamspace (knowledge:manage)
  'knowledge:read', 'knowledge:create', 'knowledge:update', 'knowledge:delete', 'knowledge:manage',
  // WeldSheets — admins also administer every spreadsheet's sharing (sheets:manage)
  'sheets:read', 'sheets:create', 'sheets:update', 'sheets:comment', 'sheets:delete', 'sheets:share', 'sheets:manage',
  // WeldDocs — admins also administer every document's sharing (docs:manage)
  'docs:read', 'docs:create', 'docs:update', 'docs:comment', 'docs:delete', 'docs:share', 'docs:manage',
  // WeldSign — admins also see every envelope and edit the settings (sign_envelopes:manage)
  'sign_envelopes:read', 'sign_envelopes:create', 'sign_envelopes:update', 'sign_envelopes:delete',
  'sign_envelopes:send', 'sign_envelopes:void', 'sign_envelopes:manage',
  'sign_templates:read', 'sign_templates:create', 'sign_templates:update', 'sign_templates:delete',
  // WeldPanel — admins also manage keys, privacy settings and usage, and erase users
  'panel_projects:read', 'panel_projects:create', 'panel_projects:update', 'panel_projects:delete', 'panel_projects:manage',
  'panel_reports:read', 'panel_reports:create', 'panel_reports:update', 'panel_reports:delete',
  'panel_recordings:read', 'panel_recordings:delete',
  'panel_people:read', 'panel_people:delete',
  // WeldReach — admins also run mailboxes (billed) and settings
  'reach_campaigns:read', 'reach_campaigns:create', 'reach_campaigns:update', 'reach_campaigns:delete',
  'reach_prospects:read', 'reach_prospects:create', 'reach_prospects:update', 'reach_prospects:delete',
  'reach_inbox:read', 'reach_inbox:update', 'reach_inbox:reply',
  'reach_mailboxes:read', 'reach_mailboxes:create', 'reach_mailboxes:update', 'reach_mailboxes:delete',
  'reach_settings:read', 'reach_settings:update',
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
  // WeldConnect (workspace automation)
  'weldconnect:workflows:read', 'weldconnect:workflows:create', 'weldconnect:workflows:update', 'weldconnect:workflows:delete',
  'weldconnect:workflow-executions:read', 'weldconnect:workflow-executions:update',
  'weldconnect:workflow-templates:read', 'weldconnect:workflow-templates:create', 'weldconnect:workflow-templates:update',
  'weldconnect:workflow-variables:read', 'weldconnect:workflow-variables:create', 'weldconnect:workflow-variables:update',
  'weldconnect:workflow-webhooks:read', 'weldconnect:workflow-webhooks:create', 'weldconnect:workflow-webhooks:update',
  'weldconnect:integrations:read', 'weldconnect:integrations:create', 'weldconnect:integrations:update',
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
  'weldads:ad_accounts:read', 'weldads:ad_accounts:update',
  'weldads:ad_campaigns:read', 'weldads:ad_campaigns:create', 'weldads:ad_campaigns:update',
  // WeldApps (user-created apps) — members can use installed apps
  'weldapps:read',
  // WeldAgent — members can view and use agents (not create/manage)
  'weldagent:read', 'weldagent:use',
  // WeldObjects — members manage records in any object, but only the ones they
  // own (no scope:all) and they cannot change object definitions (no manage).
  'weldobjects:read',
  'weldobjects:*:read', 'weldobjects:*:create', 'weldobjects:*:update',
  // WeldPass password manager — unlike developer secrets, every member gets a
  // personal vault and can start a shared one. Access inside a vault is by
  // membership, so this grants nothing over anyone else's passwords.
  'passwords:use', 'passwords:create',
  // WeldKnow — teamspace membership decides which pages a member reads and
  // edits, so these only open the app; they grant nothing inside a teamspace.
  'knowledge:read', 'knowledge:create', 'knowledge:update', 'knowledge:delete',
  // WeldSheets — a sheet's own sharing decides who edits it; these open the app.
  'sheets:read', 'sheets:create', 'sheets:update', 'sheets:comment', 'sheets:delete', 'sheets:share',
  // WeldDocs — a document's own sharing decides who edits it; these open the app.
  'docs:read', 'docs:create', 'docs:update', 'docs:comment', 'docs:delete', 'docs:share',
  // WeldSign — send and track their own signature requests; shared templates are read-only
  'sign_envelopes:read', 'sign_envelopes:create', 'sign_envelopes:update', 'sign_envelopes:delete',
  'sign_envelopes:send', 'sign_envelopes:void',
  'sign_templates:read',
  // WeldPanel — build their own reports and watch recordings; projects are read-only
  'panel_projects:read',
  'panel_reports:read', 'panel_reports:create', 'panel_reports:update', 'panel_reports:delete',
  'panel_recordings:read', 'panel_people:read',
  // WeldHR — My HR only: their own leave, expenses, sick reports, attendance
  // and payslips. Nobody else's records, no approving. Still needs the WeldHR
  // app assigned and a linked employee record.
  'employees:self',
  // WeldReach — run campaigns and answer replies; mailboxes and settings are read-only
  'reach_campaigns:read', 'reach_campaigns:create', 'reach_campaigns:update', 'reach_campaigns:delete',
  'reach_prospects:read', 'reach_prospects:create', 'reach_prospects:update', 'reach_prospects:delete',
  'reach_inbox:read', 'reach_inbox:update', 'reach_inbox:reply',
  'reach_mailboxes:read', 'reach_settings:read',
];

const LEGACY_VIEWER_PERMISSIONS: string[] = [
  'settings:general:read', 'settings:team:read', 'settings:teams:read',
  'weldcrm:*:read', 'weldstash:*:read', 'weldbooks:*:read',
  'welddesk:*:read', 'weldparcel:*:read', 'weldflow:*:read', 'weldmail:*:read',
  'weldhost:*:read', 'weldchat:*:read', 'weldconnect:*:read', 'welddrive:*:read',
  'weldcalendar:*:read', 'weldmeet:*:read', 'weldsocial:*:read',
  'weldads:ad_accounts:read', 'weldads:ad_campaigns:read',
  // WeldData (lead database) — read-only
  'prospects:read',
  // WeldApps (user-created apps) — read-only
  'weldapps:read',
  // WeldAgent — view-only
  'weldagent:read',
  // WeldObjects — read-only, own records only
  'weldobjects:read', 'weldobjects:*:read',
  // WeldKnow — read-only
  'knowledge:read',
  // WeldSheets — read-only
  'sheets:read',
  // WeldDocs — read-only
  'docs:read',
  // WeldSign — read-only: only requests they are a recipient of, and templates
  'sign_envelopes:read', 'sign_templates:read',
  // WeldPanel — shared reports and dashboards only; no recordings or profiles
  'panel_projects:read', 'panel_reports:read',
  // WeldReach — read-only
  'reach_campaigns:read', 'reach_prospects:read', 'reach_inbox:read', 'reach_mailboxes:read',
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

/**
 * What a `roles` row grants. Each workspace seeds the system roles as rows
 * (Owner/Admin/Member/Viewer), and the invite dialog assigns them by id, so
 * most members point at one. Those rows can't be edited, which means their
 * stored copy only ever lags behind grants added here after the workspace was
 * seeded (WeldKnow's `knowledge` keys, for one) — answer them from the code.
 */
export function getRoleRowPermissions(role: {
  isSystem: boolean;
  name: string;
  permissions: unknown;
}): string[] {
  const systemRole = role.isSystem ? SYSTEM_ROLES[role.name.toUpperCase()] : undefined;
  if (systemRole) return [...systemRole.permissions];
  return (role.permissions as string[] | null) ?? [];
}

/**
 * The complete access of a workspace member with `memberType = 'EMPLOYEE'`:
 * My HR (their own employee record), WeldChat, and the workspace basics the
 * shell and chat need (name/logo, the team directory for mentions). The
 * resolver uses this instead of the member's role, teams and per-member
 * extras, so an Employee member can't be widened by accident; to give
 * someone more, invite them as a team member instead.
 */
export const EMPLOYEE_MEMBER_PERMISSIONS: string[] = migratePermissionKeys([
  'settings:general:read', 'settings:team:read',
  'employees:self',
  'weldchat:channels:read', 'weldchat:channels:create',
  'weldchat:messages:read', 'weldchat:messages:create', 'weldchat:messages:update', 'weldchat:messages:delete',
  'weldchat:settings:read',
]);

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
