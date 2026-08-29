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
 * Works together with `checkAutomatically: ON_LOAD` in app.json: expo-updates
 * downloads updates in the background, and this hook picks up a ready update
 * and reloads into it before the app paints — so users don't hit a blank
 * screen on the restart that would otherwise apply the OTA.
 */
export function useUpdateGate(): boolean {
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

    const timer = setTimeout(finish, UPDATE_GATE_TIMEOUT_MS);

    (async () => {
      try {
        const result = await Updates.checkForUpdateAsync();
        if (settled.current) return;
        if (result.isAvailable) {
          await Updates.fetchUpdateAsync();
          if (settled.current) return;
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
  }, []);

  return checking;
}
