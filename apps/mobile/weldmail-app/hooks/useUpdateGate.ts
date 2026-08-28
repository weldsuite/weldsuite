import * as Updates from 'expo-updates';
import { useEffect, useRef, useState } from 'react';

const UPDATE_GATE_TIMEOUT_MS = 12000;

/**
 * On cold start, check for an OTA and reload into it before rendering the app.
 * Avoids the default expo-updates behaviour where a downloaded update is applied
 * on the *next* restart — which feels like a freeze when that bundle is bad.
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
