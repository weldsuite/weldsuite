/**
 * Native splash control for WeldBooks.
 *
 * Hide is idempotent. EAS Observe TTI is marked via useObserve().markInteractive()
 * on each entry screen — not here — so root safety timeouts don't under-report TTI.
 */

import * as SplashScreen from 'expo-splash-screen';

let hidden = false;

export function hideAppSplash(): void {
  if (hidden) return;
  hidden = true;
  SplashScreen.hideAsync().catch(() => {});
}

/** Test-only: reset the idempotency latch. */
export function resetSplashHiddenForTests(): void {
  hidden = false;
}
