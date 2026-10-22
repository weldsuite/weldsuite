import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

import { isAppLanguage, resolveAppLanguage, type AppLanguage } from './language';

export const LOCALE_STORAGE_KEY = '@weldsuite/weldchat:locale';

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

/** The phone's locale tag ("nl-NL"), when the JS engine exposes one. */
function deviceLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the last-used app language from AsyncStorage before first paint so
 * a returning Dutch user doesn't flash English on the login screen. With
 * nothing stored yet the phone's language decides, so Dutch phones get Dutch.
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
