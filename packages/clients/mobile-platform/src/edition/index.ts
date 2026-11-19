/**
 * `@weldsuite/mobile-platform/edition`: what the server offers, for hiding
 * what it lacks (the mobile side of the platform's `lib/edition.ts`, 4.F3).
 *
 * Feature names are the `unavailableFeatures` the Rust backend lists in
 * `/config.json` (`rust/bins/weldsuite/src/edition.rs`). Global lacks none.
 */

import { getMobileRuntime } from '../runtime/state';
import type { MobileEdition } from '../runtime/types';

/** The features the mobile apps check. Unknown names are fine: they're just never hidden. */
export type MobileEditionFeature =
  | 'analytics'
  | 'billing'
  | 'credit-top-up'
  | 'paid-apps'
  | 'chat-calls'
  | 'mail-domains'
  | 'mail-free-addresses'
  | 'mail-ai'
  | 'company-logos'
  | (string & {});

export function getEdition(): MobileEdition {
  return getMobileRuntime().edition;
}

/** Hook form; constant for the JS lifetime. */
export function useEdition(): MobileEdition {
  return getEdition();
}

export function isFeatureAvailable(feature: MobileEditionFeature): boolean {
  return !getMobileRuntime().unavailableFeatures.has(feature);
}

/** Hook form of `isFeatureAvailable`; constant for the JS lifetime. */
export function useEditionFeature(feature: MobileEditionFeature): boolean {
  return isFeatureAvailable(feature);
}

/** Whether the server serves an API module (`@weldsuite/api-modules` id). */
export function isModuleAvailable(moduleId: string): boolean {
  const { modules } = getMobileRuntime();
  return modules === 'all' || moduleId === 'core' || modules.has(moduleId);
}

/** Push notifications reach this app (Global and EU; not a self-hosted server until the push relay). */
export function isPushAvailable(): boolean {
  return getMobileRuntime().pushEnabled;
}

function trimSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/**
 * Whether a notification belongs to the server the app runs against. The
 * Rust backend (EU) names itself in `server` (its platform origin); Global
 * names no server. So a notification without one is Global's, and after
 * leaving Global its taps are ignored, as are another server's.
 */
export function isNotificationForThisServer(data: Record<string, unknown> | null | undefined): boolean {
  const runtime = getMobileRuntime();
  const server = typeof data?.server === 'string' ? trimSlash(data.server.trim()) : null;
  if (!server) return runtime.server.kind === 'global';
  if (runtime.server.kind === 'global') return server === 'global';
  // The build's address, the API host or the web app's: whichever the server calls itself.
  return [runtime.server.origin, runtime.apiOrigin, runtime.platformUrl].some((origin) => origin === server);
}
