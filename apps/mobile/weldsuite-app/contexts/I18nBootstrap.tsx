import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState, type ReactNode } from 'react';
import { I18nProvider } from '@weldsuite/i18n/provider';
import {
  createAsyncStorageAdapter,
  readPersistedLocale,
} from '@weldsuite/i18n/adapters/async-storage';
import { defaultLanguage, languages, type Language } from '@weldsuite/i18n/locales';

const adapter = createAsyncStorageAdapter(AsyncStorage);

/**
 * Resolves the persisted locale from AsyncStorage at app startup, then mounts
 * I18nProvider. Returns null while the AsyncStorage read is in flight — the
 * upstream ClerkLoaded gate is already showing a splash, so the brief delay
 * is invisible to users.
 */
export function I18nBootstrap({ children }: { children: ReactNode }) {
  const [initialLanguage, setInitialLanguage] = useState<Language | null>(null);

  useEffect(() => {
    readPersistedLocale(AsyncStorage, languages).then(stored => {
      setInitialLanguage(stored ?? defaultLanguage);
    });
  }, []);

  if (initialLanguage === null) return null;

  return (
    <I18nProvider initialLanguage={initialLanguage} adapter={adapter}>
      {children}
    </I18nProvider>
  );
}
