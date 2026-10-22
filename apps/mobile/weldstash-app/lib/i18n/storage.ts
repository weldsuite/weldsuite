import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

import { deviceLocale, isAppLanguage, resolveAppLanguage, type AppLanguage } from './language';

export const LOCALE_STORAGE_KEY = '@weldsuite/weldstash:locale';

export async function readPersistedLanguage(): Promise<AppLanguage | undefined> {
  try {
    const stored = await AsyncStorage.getItem(LOCALE_STORAGE_KEY);
    return isAppLanguage(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

export async function persistLanguage(language: AppLanguage): Promise<void> {
  try {
    await AsyncStorage.setItem(LOCALE_STORAGE_KEY, language);
  } catch {
    // Persistence is best-effort.
  }
}

/**
 * Resolves the app language before first paint: the last-used one when there
 * is one, otherwise the phone's language, so a Dutch phone does not flash
 * English.
 */
export function usePersistedLanguage(): { ready: boolean; language: AppLanguage } {
  const [state, setState] = useState<{ ready: boolean; language: AppLanguage }>({
    ready: false,
    language: resolveAppLanguage(deviceLocale()),
  });

  useEffect(() => {
    let cancelled = false;
    void readPersistedLanguage().then((stored) => {
      if (cancelled) return;
      setState({ ready: true, language: stored ?? resolveAppLanguage(deviceLocale()) });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
