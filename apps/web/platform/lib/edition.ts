/**
 * Edition flags (P4 work package 4.F3): which modules this deployment offers.
 *
 * The runtime config's `modules` list (`lib/runtime-config.ts`) names the
 * `ApiModuleId`s the backend serves. On Kubernetes that is the core platform
 * plus every module ported to Rust (`RUST_PORTED_MODULES` in
 * `@weldsuite/api-modules`); the apps and features of any other module are
 * hidden, since their API would answer 404. Global serves no list and
 * offers everything, exactly as before.
 *
 * An app belongs to the module whose `apps` list starts with it (its own
 * app). Apps no module owns run on the core platform (WeldDrive, for one) and
 * are always offered. Workspace-created WeldApps and custom objects are core
 * too.
 */

import { API_MODULES, type ApiModuleId } from '@weldsuite/api-modules';
import { getRuntimeConfig } from '@/lib/runtime-config';

/** App codes whose module isn't the first entry of an `apps` list (legacy and core-served codes). */
const APP_MODULE_ALIASES: Readonly<Record<string, ApiModuleId>> = {
  parcel: 'commerce',
  social: 'social',
  welddrive: 'core',
};

const APP_MODULE: ReadonlyMap<string, ApiModuleId> = (() => {
  const map = new Map<string, ApiModuleId>(Object.entries(APP_MODULE_ALIASES));
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

/** The module that serves a first-party app, or `core` for apps no module owns. */
export function moduleForApp(appCode: string): ApiModuleId {
  return APP_MODULE.get(appCode) ?? 'core';
}

/** Whether this deployment offers a first-party app (sidebar, app store, routes). */
export function isAppOffered(appCode: string): boolean {
  return isModuleOffered(moduleForApp(appCode));
}

/**
 * Whether the backend serves a feature inside the modules it offers. The
 * runtime config's `unavailableFeatures` (`UNAVAILABLE_FEATURES` in
 * `rust/bins/weldsuite/src/edition.rs`) names what it lacks; Global serves
 * no list and has every feature.
 */
export function isFeatureAvailable(feature: string): boolean {
  return !(getRuntimeConfig()?.unavailableFeatures ?? []).includes(feature);
}
