/**
 * Edition flags (4.F3), route side: which platform pages this deployment can
 * serve. A direct URL into a module the backend doesn't serve (a bookmark, a
 * notification link, a pasted URL) renders the "not available in this
 * edition" page (`components/edition-unavailable-page.tsx`) instead of a page
 * whose API answers 404. On Global everything is offered and nothing changes.
 *
 * A page needs the module of its first path segment's app (`/weldcrm/…` →
 * crm, `/settings/apps/weldmail` → mail, see `moduleForApp`), unless a more
 * specific entry below says otherwise. Pages no module owns (settings, the
 * App Store, WeldApps, objects, documents) are core and always offered.
 */

import type { ApiModuleId } from '@weldsuite/api-modules';
import { isFeatureAvailable, isModuleOffered, moduleForApp, type EditionFeature } from '@/lib/edition';
import { stripWorkspacePrefix } from '@/lib/workspace-url';

/** What a page needs: one of these modules, and this feature. */
export interface EditionRequirement {
  modules?: readonly ApiModuleId[];
  feature?: EditionFeature;
}

/**
 * Pages whose API isn't their first segment's module, longest prefix first
 * within a branch (the first match wins). Matching is on whole segments.
 */
const ROUTE_REQUIREMENTS: ReadonlyArray<readonly [prefix: string, requirement: EditionRequirement]> = [
  // WeldAgent is workspace-level: its pages have no app segment.
  ['/agents', { modules: ['agent'] }],
  ['/new-chat', { modules: ['agent'] }],
  // WeldChat's full-screen call room.
  ['/call-room', { modules: ['chat'] }],
  // Settings pages backed by a module or a feature rather than core.
  ['/settings/sso', { feature: 'sso-connections' }],
  ['/settings/plans', { feature: 'billing' }],
  ['/settings/billing', { feature: 'billing' }],
  // Buying and porting a number are Stripe checkouts through billing-worker.
  ['/settings/apps/phone-numbers/new-number', { modules: ['call'], feature: 'phone-number-purchase' }],
  ['/settings/apps/phone-numbers/port', { modules: ['call'], feature: 'phone-number-purchase' }],
  ['/settings/apps/phone-numbers', { modules: ['call'] }],
  // WeldMail pages whose API is a feature the Kubernetes editions lack.
  ['/weldmail/ai', { modules: ['mail'], feature: 'mail-ai' }],
  ['/weldmail/domains', { modules: ['mail'], feature: 'mail-domains' }],
  ['/settings/integrations', { modules: ['connect'] }],
  ['/settings/webhooks', { modules: ['connect'] }],
  // WeldBooks entities and WeldHR payroll employers share the page.
  ['/settings/entities', { modules: ['books', 'hr'] }],
  ['/settings/weldcrm', { modules: ['crm'] }],
];

function matchesPrefix(pathname: string, prefix: string): boolean {
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
  return !requirement.modules || requirement.modules.some((module) => isModuleOffered(module));
}

/** Whether this deployment serves the page at `pathname` (always true on Global). */
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
