import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

import { DEFAULT_LANGUAGE, isAppLanguage, type AppLanguage } from './language';

export const LOCALE_STORAGE_KEY = '@weldsuite/weldbooks:locale';

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
 * Resolves the last-used app language from AsyncStorage before first paint so
 * a returning Dutch user doesn't flash English on the login screen.
 */
export function usePersistedLanguage(): { ready: boolean; language: AppLanguage } {
  const [state, setState] = useState<{ ready: boolean; language: AppLanguage }>({
    ready: false,
    language: DEFAULT_LANGUAGE,
  });

  useEffect(() => {
    let cancelled = false;
    void readPersistedLanguage().then((stored) => {
      if (cancelled) return;
      setState({ ready: true, language: stored ?? DEFAULT_LANGUAGE });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
