/**
 * Which API worker serves which paths.
 *
 * app-api is being split into one worker per `weld*` module (plan:
 * docs/plans/app-api-module-split.md). This manifest is the single source of
 * truth for that split. It is read by:
 *
 *   - the clients, to pick the host for a request path (`resolveApiOrigin`)
 *   - app-api, to forward moved prefixes to the module worker
 *   - CI and local dev, to find the module workers
 *   - the ownership test, which fails when a mounted prefix is not owned by
 *     exactly one module
 *
 * Paths never change when a module moves: a module worker serves the same
 * `/api/<object>` paths app-api serves today. Only the host differs.
 *
 * Keep this file dependency-free: it is bundled into the platform SPA, the
 * mobile apps and every worker.
 */

export type ApiModuleId =
  | 'core'
  | 'crm'
  | 'desk'
  | 'mail'
  | 'flow'
  | 'books'
  | 'commerce'
  | 'stash'
  | 'host'
  | 'calendar'
  | 'meet'
  | 'chat'
  | 'call'
  | 'connect'
  | 'agent'
  | 'data'
  | 'know'
  | 'hr'
  | 'social'
  | 'ads'
  | 'pass';

export interface ApiModule {
  id: ApiModuleId;
  /** Worker package folder under apps/workers/ (also the hostname prefix). */
  worker: string;
  /** Service-binding name app-api uses to forward to this worker. */
  binding: string;
  /** `wrangler dev` port when the worker runs on its own. */
  devPort: number;
  /**
   * Full path prefixes owned by the module. Matching is on whole segments:
   * `/api/tasks` owns `/api/tasks` and `/api/tasks/123`, not `/api/tasks-x`.
   * Longest prefix wins, so `/api/desk/phone` (call) beats a shorter prefix.
   */
  prefixes: readonly string[];
}

const mod = (
  id: ApiModuleId,
  devPort: number,
  prefixes: readonly string[],
): ApiModule => ({
  id,
  worker: id === 'core' ? 'app-api' : `${id}-api`,
  binding: id === 'core' ? 'APP_API' : `${id.toUpperCase()}_API`,
  devPort,
  prefixes,
});

export const API_MODULES: readonly ApiModule[] = [
  mod('core', 8789, [
    '/api/access-requests',
    '/api/account',
    '/api/api-keys',
    '/api/app-catalog',
    '/api/appstore',
    '/api/audit-logs',
    '/api/auth-desktop',
    '/api/auth-sessions',
    '/api/billing',
    '/api/cli-auth',
    '/api/credits',
    '/api/custom-fields',
    '/api/custom-objects',
    '/api/dashboard',
    '/api/drive',
    '/api/feature-flags',
    '/api/feature-requests',
    '/api/files',
    '/api/folders',
    '/api/grid-views',
    '/api/internal',
    '/api/invitations',
    '/api/me',
    '/api/member-limits',
    '/api/my-role',
    '/api/notification-preferences',
    '/api/notifications',
    '/api/object-templates',
    '/api/objects',
    '/api/onboarding',
    '/api/prepaid-seats',
    '/api/push-tokens',
    '/api/related',
    '/api/roles',
    '/api/search',
    '/api/settings/profile',
    '/api/storage',
    '/api/support',
    '/api/team-members',
    '/api/user-apps',
    '/api/user-preferences',
    '/api/workspace-api-keys',
    '/api/workspace-settings',
    '/api/workspaces',
    '/public/user-apps',
  ]),
  mod('crm', 8801, [
    '/api/activities',
    '/api/companies',
    '/api/crm-analytics',
    '/api/customer-sequences',
    '/api/customer-statuses',
    '/api/leads',
    '/api/lists',
    '/api/opportunities',
    '/api/people',
    '/api/person-companies',
    '/api/pipeline-field-visibility',
    '/api/pipeline-stages',
    '/api/pipelines',
    '/api/sequences',
  ]),
  mod('desk', 8802, [
    '/api/article-folders',
    '/api/articles',
    '/api/canned-responses',
    '/api/conversations',
    '/api/desk/conversations',
    '/api/desk/widget',
    '/api/helpcenter-settings',
    '/api/helpdesk-agents',
    '/api/helpdesk-analytics',
    '/api/helpdesk-announcements',
    '/api/helpdesk-changelog',
    '/api/helpdesk-contacts',
    '/api/helpdesk-departments',
    '/api/helpdesk-email',
    '/api/helpdesk-faqs',
    '/api/helpdesk-feedback',
    '/api/helpdesk-integrations',
    '/api/helpdesk-news',
    '/api/helpdesk-reviews',
    '/api/helpdesk-settings',
    '/api/helpdesk-stats',
    '/api/helpdesk-weldagent',
    '/api/helpdesk-workflows',
    '/api/integrations/helpdesk',
    '/api/satisfaction-surveys',
    '/api/slas',
    '/api/ticket-messages',
    '/api/ticket-notes',
    '/api/ticket-types',
    '/api/tickets',
    '/public/helpcenter',
  ]),
  mod('mail', 8803, [
    '/api/mail-accounts',
    '/api/mail-ai',
    '/api/mail-attachments',
    '/api/mail-campaigns',
    '/api/mail-domains',
    '/api/mail-drafts',
    '/api/mail-folders',
    '/api/mail-labels',
    '/api/mail-messages',
    '/api/mail-rules',
    '/api/mail-scheduled',
    '/api/mail-signatures',
    '/api/mail-snooze',
    '/api/mail-subscriptions',
    '/api/mail-sync',
    '/api/mail-templates',
    '/api/mail-threads',
    '/api/mail-weldmail',
    '/api/mailboxes',
  ]),
  mod('flow', 8804, [
    '/api/digest-settings',
    '/api/documents',
    '/api/goals',
    '/api/milestones',
    '/api/my-tasks',
    '/api/project-analytics',
    '/api/project-documents',
    '/api/project-files',
    '/api/project-labels',
    '/api/project-members',
    '/api/project-messages',
    '/api/project-pipeline-stages',
    '/api/project-sheets',
    '/api/projects',
    '/api/sprints',
    '/api/task-comments',
    '/api/task-projects',
    '/api/task-tags',
    '/api/tasks',
    '/api/time-entries',
    '/api/whiteboards',
  ]),
  mod('books', 8805, [
    '/api/accounting-contacts',
    '/api/accounting-dashboard',
    '/api/accounting-documents',
    '/api/accounting-entities',
    '/api/accounting-exports',
    '/api/accounting-reports',
    '/api/accounting-settings',
    '/api/bank-accounts',
    '/api/bank-transactions',
    '/api/bills',
    '/api/fiscal-periods',
    '/api/fx-rates',
    '/api/gl-accounts',
    '/api/icp-declarations',
    '/api/invoices',
    '/api/journal-entries',
    '/api/payments',
    '/api/reconciliation-rules',
    '/api/recurring-invoices',
    '/api/tax-rates',
    '/api/vat-returns',
  ]),
  mod('commerce', 8806, [
    '/api/carriers',
    '/api/categories',
    '/api/commerce-portal',
    '/api/orders',
    '/api/parcel-analytics',
    '/api/parcel-notifications',
    '/api/parcel-rates',
    '/api/parcel-settings',
    '/api/parcel-wallet',
    '/api/parcels',
    '/api/pickups',
    '/api/printnode',
    '/api/products',
    '/api/return-reasons',
    '/api/return-rules',
    '/api/returns',
    '/api/sendcloud',
    '/api/shipments',
    '/api/shipping-prices',
    '/api/shipping-rules',
    '/public/commerce-portal',
    '/webhooks/woocommerce',
  ]),
  mod('stash', 8807, [
    '/api/boxes',
    '/api/cycle-counts',
    '/api/inventory',
    '/api/inventory-movements',
    '/api/pick-lists',
    '/api/pickers',
    '/api/purchase-orders',
    '/api/putaway',
    '/api/stock-adjustments',
    '/api/warehouse-locations',
    '/api/warehouse-zones',
    '/api/warehouses',
    '/api/wms-activity',
    '/api/wms-suppliers',
  ]),
  mod('host', 8808, [
    '/api/dns-records',
    '/api/dns-zones',
    '/api/domain-transfers',
    '/api/domains',
    '/api/email-forwards',
    '/public/webhooks/realtime-register',
  ]),
  mod('calendar', 8809, [
    '/api/booking-pages',
    '/api/bookings',
    '/api/calendar-events',
    '/api/calendars',
    '/api/working-hours',
  ]),
  mod('meet', 8810, [
    '/api/meeting-bot-sessions',
    '/api/meeting-messages',
    '/api/meeting-sessions',
    '/api/meeting-waitlist',
    '/api/meetings',
    '/api/transcriptions',
    '/api/webhooks/cloudflare-realtime',
    '/api/webhooks/meeting-bot',
  ]),
  mod('chat', 8811, [
    '/api/channel-members',
    '/api/channels',
    '/api/chat-activity',
    '/api/chat-bookmarks',
    '/api/chat-calls',
    '/api/chat-clips',
    '/api/chat-directories',
    '/api/chat-dm',
    '/api/chat-drafts',
    '/api/chat-entity-channels',
    '/api/chat-messages',
    '/api/chat-search',
    '/api/chat-sections',
    '/api/chat-status',
  ]),
  mod('call', 8812, [
    '/api/call-intelligence',
    '/api/calls',
    '/api/desk/phone',
    '/api/porting',
    '/api/telephony',
    '/public/webhooks/telnyx',
  ]),
  mod('connect', 8813, [
    '/api/connectors',
    '/api/external-webhooks',
    '/api/github-connections',
    '/api/github-project-links',
    '/api/github-repo-links',
    '/api/integrations',
    '/api/weldconnect/github',
    '/api/workflow-builder',
    '/api/workflow-dashboard',
    '/api/workflow-executions',
    '/api/workflow-github',
    '/api/workflow-integrations',
    '/api/workflow-schedules',
    '/api/workflow-templates',
    '/api/workflow-triggers',
    '/api/workflow-variables',
    '/api/workflow-webhooks',
    '/api/workflows',
  ]),
  mod('agent', 8814, ['/api/ai', '/api/ai-models', '/api/chat-agent', '/api/weldagent']),
  mod('data', 8815, ['/api/enrich-fields', '/api/enrichments', '/api/welddata']),
  mod('know', 8816, ['/api/knowledge']),
  mod('hr', 8817, ['/api/weldhr', '/public/hr-portal']),
  mod('social', 8818, [
    '/api/social-accounts',
    '/api/social-analytics',
    '/api/social-approvals',
    '/api/social-campaigns',
    '/api/social-media',
    '/api/social-posts',
    '/api/social-settings',
    '/api/social-team-members',
    '/public/social/postpeer',
  ]),
  mod('ads', 8819, ['/api/ad-accounts', '/api/ad-campaigns', '/api/ad-connections']),
  mod('pass', 8820, ['/api/weldpass']),
];

const BY_ID = new Map(API_MODULES.map((m) => [m.id, m]));

export function getApiModule(id: ApiModuleId): ApiModule {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Unknown API module: ${id}`);
  return found;
}

/** Every module except core, i.e. the ones that get their own worker. */
export const MODULE_WORKERS: readonly ApiModule[] = API_MODULES.filter((m) => m.id !== 'core');

function ownsPath(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`);
}

// Longest first, so the most specific prefix wins.
const PREFIX_INDEX: ReadonlyArray<{ prefix: string; module: ApiModule }> = API_MODULES.flatMap(
  (m) => m.prefixes.map((prefix) => ({ prefix, module: m })),
).sort((a, b) => b.prefix.length - a.prefix.length);

/**
 * The module that owns a full request path (`/api/tickets/123`). Paths no
 * module claims belong to core, which is where they are served today.
 */
export function findModuleForPath(path: string): ApiModule {
  for (const entry of PREFIX_INDEX) {
    if (ownsPath(entry.prefix, path)) return entry.module;
  }
  return getApiModule('core');
}

/**
 * Parse a comma-separated module list (`VITE_API_MODULES=pass,host`). Unknown
 * ids and `core` are dropped, so a typo can never send traffic nowhere.
 */
export function parseModuleList(value: string | undefined | null): Set<ApiModuleId> {
  const out = new Set<ApiModuleId>();
  if (!value) return out;
  for (const raw of value.split(',')) {
    const id = raw.trim() as ApiModuleId;
    if (id && id !== 'core' && BY_ID.has(id)) out.add(id);
  }
  return out;
}

/**
 * Derive a module worker's origin from the core (app-api) origin:
 *
 *   https://app-api.weldsuite.org       → https://crm-api.weldsuite.org
 *   https://app-api-test.weldsuite.org  → https://crm-api-test.weldsuite.org
 *   http://localhost:8789               → http://localhost:8801
 *
 * Any other origin (a custom proxy, a preview host) cannot be mapped, so it is
 * returned unchanged and app-api's forwarder serves the module instead.
 */
export function moduleOriginFrom(coreOrigin: string, module: ApiModule): string {
  if (module.id === 'core') return coreOrigin;
  let url: URL;
  try {
    url = new URL(coreOrigin);
  } catch {
    return coreOrigin;
  }
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    url.port = String(module.devPort);
    return url.origin;
  }
  const match = /^app-api(-[a-z0-9]+)?\.(.+)$/.exec(url.hostname);
  if (!match) return coreOrigin;
  url.hostname = `${module.worker}${match[1] ?? ''}.${match[2]}`;
  return url.origin;
}

export interface ApiOriginResolverOptions {
  /** app-api origin, e.g. `https://app-api.weldsuite.org` (no trailing slash). */
  coreOrigin: string;
  /**
   * Modules the client talks to directly. Everything else goes to app-api,
   * which forwards moved prefixes, so an empty set behaves exactly like the
   * single-worker setup.
   */
  enabled: ReadonlySet<ApiModuleId>;
  /** Explicit origin per module (e.g. from `VITE_CRM_API_URL`); wins over derivation. */
  overrides?: Partial<Record<ApiModuleId, string>>;
}

/**
 * Build `path → origin` for a client. `path` is the full request path
 * (`/api/tickets/123`).
 */
export function createApiOriginResolver(options: ApiOriginResolverOptions) {
  const coreOrigin = options.coreOrigin.replace(/\/+$/, '');
  const cache = new Map<ApiModuleId, string>();

  const originFor = (module: ApiModule): string => {
    if (module.id === 'core' || !options.enabled.has(module.id)) return coreOrigin;
    const cached = cache.get(module.id);
    if (cached) return cached;
    const origin = (options.overrides?.[module.id] ?? moduleOriginFrom(coreOrigin, module)).replace(
      /\/+$/,
      '',
    );
    cache.set(module.id, origin);
    return origin;
  };

  return {
    originForPath: (path: string) => originFor(findModuleForPath(path)),
    originForModule: (id: ApiModuleId) => originFor(getApiModule(id)),
    /** Every origin this client may call (core first). */
    allOrigins: (): string[] => [
      coreOrigin,
      ...[...options.enabled].map((id) => originFor(getApiModule(id))),
    ],
  };
}

export type ApiOriginResolver = ReturnType<typeof createApiOriginResolver>;
