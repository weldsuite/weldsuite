/**
 * Edition flags (4.F3), route side: which platform pages this deployment can
 * serve. A direct URL into a module the backend doesn't serve (a bookmark, a
 * notification link, a pasted URL) renders the "not available in this
 * edition" page (`components/edition-unavailable-page.tsx`) instead of a page
 * whose API answers 404. Without a runtime config everything is offered.
 *
 * A page needs the module of its first path segment's app (`/weldcrm/…` →
 * crm, `/settings/apps/weldmail` → mail, see `moduleForApp`), unless a more
 * specific entry below says otherwise. Pages no module owns (settings, the
 * App Store, WeldApps, objects, documents) are core and always offered.
 */

import type { ApiModuleId } from '@weldsuite/app-api-client/schemas/runtime-config';
import { hasAiSettings, isFeatureAvailable, isModuleOffered, moduleForApp, type EditionFeature } from '@/lib/edition';
import { getRuntimeConfig, publicEnv } from '@/lib/runtime-config';
import { stripWorkspacePrefix } from '@/lib/workspace-url';

/** What a page needs: one of these modules, this feature, and one of `anyFeature`. */
export interface EditionRequirement {
  modules?: readonly ApiModuleId[];
  feature?: EditionFeature;
  anyFeature?: readonly EditionFeature[];
  /** The install runs AI with workspace settings (`ai` in `/config.json`). */
  ai?: boolean;
  /**
   * A public setting the install must name in `/config.json` (`env`), such
   * as the origin of a service it may not run. Not checked without a runtime
   * config.
   */
  publicEnv?: `VITE_${string}`;
}

/**
 * Settings → Integrations pages every edition offers: the OAuth return page,
 * the connectors and the providers workflow steps use (their APIs are core,
 * ADR INT-014). Whether a connector appears also depends on the connector
 * catalog the backend serves (Odoo only on the Kubernetes editions).
 */
export const CORE_INTEGRATION_PAGES: readonly string[] = [
  'callback',
  // Store, accounting and ERP connectors.
  'woocommerce',
  'shopify',
  'moneybird',
  'stripe',
  'picqer',
  'odoo',
  // Providers workflow steps use; Slack and Google Calendar share their page.
  'slack',
  'google-calendar',
  'gmail',
  'google-sheets',
];

/**
 * Pages whose API isn't their first segment's module, longest prefix first
 * within a branch (the first match wins). Matching is on whole segments.
 */
const ROUTE_REQUIREMENTS: ReadonlyArray<readonly [prefix: string, requirement: EditionRequirement]> = [
  // WeldAgent is workspace-level: its pages have no app segment.
  ['/agents', { modules: ['agent'] }],
  ['/new-chat', { modules: ['agent'], feature: 'assistant-ai' }],
  // WeldChat's full-screen call room.
  ['/call-room', { modules: ['chat'] }],
  // Settings pages backed by a module or a feature rather than core.
  ['/settings/sso', { feature: 'sso-connections' }],
  ['/settings/ai', { ai: true }],
  // The EU edition's opt-in for services outside the EU (ADR OPS-026).
  ['/settings/outside-eu', { feature: 'outside-eu-services' }],
  ['/settings/plans', { feature: 'billing' }],
  // Billing, or on the Kubernetes editions just the credit balance and its
  // top-up (Mollie).
  ['/settings/billing', { anyFeature: ['billing', 'credit-top-up'] }],
  // Buying and porting a number are Stripe checkouts through billing-worker.
  ['/settings/apps/phone-numbers/new-number', { modules: ['call'], feature: 'phone-number-purchase' }],
  ['/settings/apps/phone-numbers/port', { modules: ['call'], feature: 'phone-number-purchase' }],
  ['/settings/apps/phone-numbers', { modules: ['call'] }],
  // WeldMail pages whose API is a feature the Kubernetes editions lack.
  ['/weldmail/ai', { modules: ['mail'], feature: 'mail-ai' }],
  // The click-time link check (`POST /api/mail-messages/:id/link-check`), Rust only.
  ['/weldmail/link', { modules: ['mail'], feature: 'mail-threat-protection' }],
  ['/weldmail/domains', { modules: ['mail'], feature: 'mail-domains' }],
  // MCP servers are WeldAgent's tools.
  ['/settings/integrations/mcp-servers', { modules: ['agent'] }],
  // Google Calendar's calendar sync returns here; the sync itself needs `integration-sync`.
  ['/settings/integrations/google-calendar/callback', { feature: 'integration-sync' }],
  // Integrations are core platform (ADR INT-014), served on both backends
  // whatever the workspace has installed: the OAuth return page, the store,
  // accounting and ERP connectors (`/api/connectors`), and the providers
  // workflow steps use (`/api/workflow-integrations`). Slack's and Google
  // Calendar's pages show their helpdesk channel and calendar sync only where
  // `integration-sync` runs.
  ...CORE_INTEGRATION_PAGES.map((page) => [`/settings/integrations/${page}`, {}] as const),
  // The other integrations (CRM sync, Discord, GitHub) need `integration-sync`,
  // which the Kubernetes editions lack.
  ['/settings/integrations/', { feature: 'integration-sync' }],
  // The old WeldConnect return URLs: core too.
  ['/weldconnect/connectors/callback', {}],
  ['/weldconnect/integrations/callback', {}],
  // The public API (external-api) has no Kubernetes port yet: keys need the
  // origin they work against, which `/config.json` names once it has one.
  ['/settings/api-keys', { publicEnv: 'VITE_EXTERNAL_API_URL' }],
  // WeldDesk's BI connector is an OData feed on that same public API, read
  // with one of those keys.
  ['/settings/apps/welddesk/bi-connector', { modules: ['desk'], publicEnv: 'VITE_EXTERNAL_API_URL' }],
  // The public help center site runs on Global only (`{slug}.welddesk.org`).
  ['/settings/apps/welddesk/help-center', { modules: ['desk'], feature: 'helpcenter-hosting' }],
  // WeldBooks entities and WeldHR payroll employers share the page.
  ['/settings/entities', { modules: ['books', 'hr'] }],
  ['/settings/weldcrm', { modules: ['crm'] }],
  // WeldPanel's settings (usage, exports, API) need the analytics backend,
  // which the Kubernetes editions lack: they serve only the Projects pages.
  ['/settings/apps/weldpanel', { modules: ['panel'], feature: 'panel-analytics' }],
  // WeldStash's settings and Replenishment; without them its purchase orders
  // keep just their create, edit and delete.
  ['/settings/apps/weldstash', { modules: ['stash'], feature: 'stash-replenishment' }],
  ['/weldstash/replenishment', { modules: ['stash'], feature: 'stash-replenishment' }],
  // Carrier shipping (PostNL, DHL Parcel labels, tracking, returns) exists only on the Rust backend.
  ['/weldstash/shipments', { modules: ['stash'], feature: 'stash-shipping' }],
  // WeldBooks' to-process list and counts (`/api/accounting-todo`) are built only in Rust.
  ['/weldbooks/to-process', { modules: ['books'], feature: 'books-todo' }],
  // WeldBooks' review screen for an inbox document and the SEPA payment files (Pay bills) are built only in Rust.
  ['/weldbooks/documents/', { modules: ['books'], feature: 'books-receipts' }],
  ['/weldbooks/purchases/pay', { modules: ['books'], feature: 'books-sepa-batches' }],
  // WeldBooks quotes (list, form, panel) are built only in Rust.
  ['/weldbooks/quotes', { modules: ['books'], feature: 'books-quotes' }],
  // WeldBooks' unbilled time (invoicing WeldFlow hours once) is built only in Rust.
  ['/weldbooks/time', { modules: ['books'], feature: 'books-time-billing' }],
  // WeldBooks' questions list (questions to the accountant, ADR BOOKS-015) is built only in Rust.
  ['/weldbooks/questions', { modules: ['books'], feature: 'books-questions' }],
  // WeldPass's settings (the offline copy and its devices) exist only on the Rust backend (ADR PASS-010).
  ['/settings/apps/weldpass', { modules: ['pass'], feature: 'weldpass-offline' }],
];

function matchesPrefix(pathname: string, prefix: string): boolean {
  // A prefix ending in `/` matches only the pages below it, not the page itself.
  if (prefix.endsWith('/')) return pathname.startsWith(prefix) && pathname.length > prefix.length;
  return pathname === prefix || pathname.startsWith(prefix + '/');
}

/**
 * What the page at `pathname` (bare, without `/w/{workspace}`; a query or
 * hash is ignored) needs, or null when it needs only core.
 */
export function routeRequirement(pathname: string): EditionRequirement | null {
  const path = pathname.split(/[?#]/, 1)[0];
  for (const [prefix, requirement] of ROUTE_REQUIREMENTS) {
    if (matchesPrefix(path, prefix)) return requirement;
  }
  const segments = path.split('/').filter(Boolean);
  // `/settings/apps/{app}`: the app's own settings.
  const appCode = segments[0] === 'settings' && segments[1] === 'apps' ? segments[2] : segments[0];
  if (!appCode) return null;
  const module = moduleForApp(appCode);
  return module === 'core' ? null : { modules: [module] };
}

/** Whether this deployment offers what a requirement asks for. */
export function isRequirementMet(requirement: EditionRequirement | null): boolean {
  if (!requirement) return true;
  if (requirement.feature && !isFeatureAvailable(requirement.feature)) return false;
  if (requirement.anyFeature && !requirement.anyFeature.some((feature) => isFeatureAvailable(feature))) return false;
  if (requirement.ai && !hasAiSettings()) return false;
  if (requirement.publicEnv && getRuntimeConfig() && !publicEnv(requirement.publicEnv)) return false;
  return !requirement.modules || requirement.modules.some((module) => isModuleOffered(module));
}

/** Whether this deployment serves the page at `pathname` (always true without a runtime config). */
export function isRouteOffered(pathname: string): boolean {
  return isRequirementMet(routeRequirement(pathname));
}

/**
 * Whether an in-app link (a notification's `actionUrl`, …) opens a page this
 * deployment serves. Query, hash and a `/w/{workspace}` prefix are ignored;
 * anything that isn't an in-app path is left alone.
 */
export function isHrefOffered(href: string): boolean {
  if (!href.startsWith('/') || href.startsWith('//')) return true;
  return isRouteOffered(stripWorkspacePrefix(href.split(/[?#]/, 1)[0]));
}
