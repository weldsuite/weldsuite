import type { LocaleAdapter } from '../adapter';
import type { Language } from '../locales';

export interface AsyncStorageLike {
  setItem(key: string, value: string): Promise<void> | void;
  getItem?(key: string): Promise<string | null> | string | null;
  removeItem?(key: string): Promise<void> | void;
}

const KEY = '@weldsuite/i18n:locale';

/**
 * Mobile adapter (React Native + AsyncStorage).
 *
 * AsyncStorage is asynchronous, so the locale must be pre-resolved at app
 * startup (await storage.getItem(...)) and passed to the provider via
 * `initialLanguage`. This adapter handles the WRITE side and an optional
 * out-of-band subscription for OS-level locale changes.
 */
export function createAsyncStorageAdapter(storage: AsyncStorageLike): LocaleAdapter {
  return {
    write(locale: Language) {
      const result = storage.setItem(KEY, locale);
      if (result instanceof Promise) {
        result.catch(() => {
          // Swallow — locale persistence is best-effort.
        });
      }
    },
  };
}

/**
 * Helper for the mobile app's startup code: resolves the persisted locale
 * before mounting the provider. Returns `undefined` if nothing is stored.
 */
export async function readPersistedLocale(
  storage: AsyncStorageLike,
  languages: readonly Language[]
): Promise<Language | undefined> {
  if (!storage.getItem) return undefined;
  const stored = await storage.getItem(KEY);
  if (stored && (languages as readonly string[]).includes(stored)) {
    return stored as Language;
  }
  return undefined;
}
