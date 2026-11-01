/**
 * Edition flags (P4 work package 4.F3): which modules and features this
 * deployment offers.
 *
 * The runtime config's `modules` list (`lib/runtime-config.ts`) names the
 * `ApiModuleId`s the backend serves. On Kubernetes that is the core platform
 * plus every module ported to Rust (`RUST_PORTED_MODULES` in
 * `@weldsuite/api-modules`); the apps and features of any other module are
 * hidden, since their API would answer 404. Its `unavailableFeatures` list
 * names what the backend lacks inside the modules it does serve (billing,
 * SSO connections, …). Global serves neither list and offers everything,
 * exactly as before.
 *
 * Both lists are read once, before the first render, and never change while
 * the app runs, so these are plain functions: components and hooks call them
 * directly.
 *
 * An app belongs to the module whose `apps` list starts with it (its own
 * app). Legacy and alternative codes (`task`, `accounting`, `wms`, …) resolve
 * through `normalizeAppCode` first, as the permission checks do. Workspace-
 * created WeldApps and custom objects are core.
 */

import { API_MODULES, type ApiModuleId } from '@weldsuite/api-modules';
import { normalizeAppCode } from '@weldsuite/permissions';
import { getRuntimeConfig } from '@/lib/runtime-config';

/**
 * Features the Rust backend lacks inside the modules it serves
 * (`UNAVAILABLE_FEATURES` in `rust/bins/weldsuite/src/edition.rs`).
 */
export const EDITION_FEATURES = [
  /** SAML connections (`/api/sso` connection changes). */
  'sso-connections',
  /** Plans, subscriptions, seats, payment methods and invoices (Stripe). */
  'billing',
  /** Buying credits (a Stripe checkout). */
  'credit-top-up',
  /** Paid WeldApps: subscriptions and developer payouts (Stripe). */
  'paid-apps',
  /** The desktop app's sign-in ticket (`/api/auth-desktop/ticket`). */
  'desktop-sign-in',
  /** Analytics pages (Cloudflare's analytics store). */
  'analytics',
  /** `POST /api/search/reindex`. */
  'search-reindex',
  /** Company logos fetched from each company's website (`POST /api/company-logos/resolve`). */
  'company-logos',
  /** Custom mail domains (`/api/mail-domains`, Cloudflare Email Routing and DNS; ADR MAIL-010). */
  'mail-domains',
  /** Free `{slug}.weldmail.com` addresses (`/api/mail-weldmail`; off on Kubernetes, ADR MAIL-010). */
  'mail-free-addresses',
  /** WeldMail's AI drafts, replies, summaries and smart replies (`/api/mail-ai`). */
  'mail-ai',
  /** WeldChat voice and video calls (`/api/chat-calls`, Cloudflare RealtimeKit). */
  'chat-calls',
  /** WeldDesk help center custom domains (a Cloudflare zone record and a Vercel-hosted help center). */
  'helpcenter-custom-domains',
  /** WeldBooks document OCR (`POST /api/accounting-documents/:id/process`, Workers AI). */
  'books-ocr',
  /** Filing the BTW-aangifte and the Opgaaf ICP through Digipoort (a PKIoverheid client certificate). */
  'vat-digipoort',
] as const;

export type EditionFeature = (typeof EDITION_FEATURES)[number];

/**
 * App codes served by a module other than their canonical app's own one, or
 * by none. WeldAgent is workspace-level (its module has no `apps` list);
 * Parcel's screens call commerce's `/api/parcels`; WeldDrive and the
 * WeldSuite home are the core platform.
 */
const APP_MODULE_OVERRIDES: Readonly<Record<string, ApiModuleId>> = {
  weldagent: 'agent',
  agent: 'agent',
  parcel: 'commerce',
  weldparcel: 'commerce',
  welddrive: 'core',
  weldsuite: 'core',
};

/** Canonical app code → the module whose own app it is. */
const APP_MODULE: ReadonlyMap<string, ApiModuleId> = (() => {
  const map = new Map<string, ApiModuleId>();
  for (const module of API_MODULES) {
    const own = module.apps?.[0];
    if (own && !map.has(own)) map.set(own, module.id);
  }
  return map;
})();

/** The modules this deployment offers, or null when it offers every module (Global). */
export function offeredModules(): ReadonlySet<string> | null {
  const modules = getRuntimeConfig()?.modules;
  return modules ? new Set(['core', ...modules]) : null;
}

/** Whether this deployment serves the module. */
export function isModuleOffered(module: ApiModuleId): boolean {
  const offered = offeredModules();
  return offered === null || offered.has(module);
}

/**
 * The module that serves a first-party app, legacy codes included, or `core`
 * for codes no module owns (WeldDrive, workspace-made apps and objects).
 */
export function moduleForApp(appCode: string): ApiModuleId {
  const lower = appCode.trim().toLowerCase();
  const override = APP_MODULE_OVERRIDES[lower];
  if (override) return override;
  const canonical = normalizeAppCode(lower) ?? lower;
  return APP_MODULE_OVERRIDES[canonical] ?? APP_MODULE.get(canonical) ?? 'core';
}

/** Whether this deployment offers a first-party app (sidebar, app store, routes). */
export function isAppOffered(appCode: string): boolean {
  return isModuleOffered(moduleForApp(appCode));
}

/** Whether this deployment offers a feature (`unavailableFeatures` doesn't name it). */
export function isFeatureAvailable(feature: EditionFeature): boolean {
  return !(getRuntimeConfig()?.unavailableFeatures?.includes(feature) ?? false);
}
