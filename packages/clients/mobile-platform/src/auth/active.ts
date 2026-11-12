/**
 * Which identity provider backs the facade: chosen from the booted runtime
 * on first use and fixed for the JS lifetime (a server switch reloads the
 * app), so the hooks behind the facade never change under a mounted tree.
 */

import { peekMobileRuntime } from '../runtime/state';
import { clerkAuth } from './clerk';
import { oidcAuth } from './oidc/adapter';
import type { AuthImplementation } from './types';

let active: AuthImplementation | null = null;

export function getAuthImplementation(): AuthImplementation {
  if (active) return active;
  const runtime = peekMobileRuntime();
  if (!runtime) {
    throw new Error('Auth is read before the mobile runtime booted. Render it under <ServerRuntimeGate>.');
  }
  active = runtime.auth.provider === 'oidc' ? oidcAuth : clerkAuth;
  return active;
}

/** For tests: put an implementation behind the facade, or reset with null. */
export function setAuthImplementation(implementation: AuthImplementation | null): void {
  active = implementation;
}

/** Sign out outside React (switching server). A no-op before boot. */
export async function signOutActive(): Promise<void> {
  if (!active && !peekMobileRuntime()) return;
  await getAuthImplementation().signOut();
}
