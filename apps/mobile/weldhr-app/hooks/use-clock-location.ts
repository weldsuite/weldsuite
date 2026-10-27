import { useCallback, useState } from 'react';
import * as Location from 'expo-location';

import { locateForClock, type LocateResult, type LocationSource } from '@/lib/location';

/** A fix older than this is no use for "are you at work right now". */
const LAST_KNOWN_MAX_AGE_MS = 2 * 60_000;

const source: LocationSource = {
  requestPermission: async () => {
    const { granted } = await Location.requestForegroundPermissionsAsync();
    return { granted };
  },
  currentPosition: () => Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
  lastKnownPosition: () => Location.getLastKnownPositionAsync({ maxAge: LAST_KNOWN_MAX_AGE_MS }),
};

/**
 * The device's position for a clock in or out, when the workspace requires
 * being at a work location. `locate()` asks for permission (once the OS will),
 * then for a fix; `locating` is true meanwhile, for the button's spinner.
 * Outside that rule nothing is asked and `locate()` resolves to nothing.
 */
export function useClockLocation(required: boolean) {
  const [locating, setLocating] = useState(false);

  const locate = useCallback(async (): Promise<LocateResult | null> => {
    if (!required) return null;
    setLocating(true);
    try {
      return await locateForClock(source);
    } finally {
      setLocating(false);
    }
  }, [required]);

  return { locate, locating };
}
