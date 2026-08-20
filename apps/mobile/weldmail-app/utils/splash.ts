/**
 * Native splash control for WeldMail.
 *
 * We keep the splash up (preventAutoHide) until the first real screen has
 * something to show — the inbox, or the email opened from a notification —
 * so a tap never flashes "Initializing…" / "Loading…". Hide is idempotent
 * and always async-catch, so a second call from another screen is a no-op.
 *
 * Hide BEFORE any sheet/modal is presented; leaving the splash up across a
 * formSheet is what used to fight UIKit view controllers.
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
