import * as Updates from 'expo-updates';
import { useEffect, useRef, useState } from 'react';

/**
 * How long we're willing to block the launch waiting for an OTA update.
 * If the check/download hasn't finished by then we launch with whatever
 * bundle we already have, and the update (if any) applies on the next restart
 * — i.e. we gracefully fall back to expo-updates' default behaviour.
 */
const UPDATE_GATE_TIMEOUT_MS = 12000;

/**
 * Gates the very first cold-start render on an OTA update check.
 *
 * By default expo-updates launches instantly with the embedded/cached bundle
 * and only applies a freshly-downloaded update on the *next* restart. That's
 * why a first-time installer sees the (older) bundle baked into the store
 * binary and only gets the latest JS after quitting and reopening.
 *
 * This hook flips that for the first launch only: it checks for an update,
 * downloads it, and relaunches into it *before* the app renders — behind the
 * splash/loader — so users never see a stale UI. It degrades safely:
 *   - disabled in dev / Expo Go (Updates.isEnabled === false)
 *   - never blocks longer than UPDATE_GATE_TIMEOUT_MS
 *   - a failed check (offline, server error) just launches the cached bundle
 *
 * @returns `true` while the update check is in flight (render your loader),
 *          `false` once it's safe to render the app.
 */
export function useUpdateGate(): boolean {
  // Only gate when updates can actually run. In dev/Expo Go this is false, so
  // we never block and the hook is a no-op.
  const [checking, setChecking] = useState<boolean>(() => Updates.isEnabled && !__DEV__);
  const settled = useRef(false);

  useEffect(() => {
    if (!Updates.isEnabled || __DEV__) {
      setChecking(false);
      return;
    }

    const finish = () => {
      if (settled.current) return;
      settled.current = true;
      setChecking(false);
    };

    // Safety net: never hold the user on a hanging network request.
    const timer = setTimeout(finish, UPDATE_GATE_TIMEOUT_MS);

    (async () => {
      try {
        const result = await Updates.checkForUpdateAsync();
        if (settled.current) return; // timed out while checking
        if (result.isAvailable) {
          await Updates.fetchUpdateAsync();
          if (settled.current) return; // timed out while downloading — apply next launch
          // Relaunch into the new bundle. On success nothing after this runs;
          // if reloadAsync() rejects we fall through to finish() below so the
          // launch is never left hanging on the splash screen.
          await Updates.reloadAsync();
          return;
        }
      } catch (err) {
        if (__DEV__) console.warn('[useUpdateGate] update check failed', err);
      }
      clearTimeout(timer);
      finish();
    })();

    return () => clearTimeout(timer);
    // Intentionally run once on mount (cold start only).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return checking;
}
