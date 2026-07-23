import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import type { TranslationsType } from './types';
import {
  defaultLanguage,
  getLoadedTranslations,
  isLocaleLoaded,
  languages,
  loadLocale,
  type Language,
} from './locales';
import type { LocaleAdapter } from './adapter';
import { cookieAdapter } from './adapters/cookie';
import { plural as pluralImpl, type PluralForms } from './plural';

interface I18nContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: TranslationsType;
  /**
   * Locale-aware plural form picker. Substitutes `{count}` in the chosen form.
   * @example pluralize(items.length, { one: '{count} item', other: '{count} items' })
   */
  plural: (count: number, forms: PluralForms) => string;
  /**
   * Substitute `{name}` placeholders in a translation string with values.
   * For React-children interpolation use the `<Trans>` component instead.
   */
  format: (template: string, values: Record<string, unknown>) => string;
}

const I18nContext = createContext<I18nContextType | undefined>(undefined);

interface I18nProviderProps {
  children: ReactNode;
  /**
   * Locale resolved by the caller before mount (e.g. read from a request
   * header on the server, or from AsyncStorage at app startup on mobile).
   * Takes precedence over the adapter's `read()` and browser detection.
   */
  initialLanguage?: Language;
  /**
   * Source/sink for locale persistence and cross-context updates.
   * Defaults to the web cookie adapter, which preserves the platform's
   * existing behavior.
   */
  adapter?: LocaleAdapter;
}

function detectBrowserLanguage(): Language | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const browserLang = navigator.language?.toLowerCase();
  if (!browserLang) return undefined;
  return languages.find(lang => browserLang.startsWith(lang));
}

export function I18nProvider({
  children,
  initialLanguage,
  adapter = cookieAdapter,
}: I18nProviderProps) {
  const [language, setLanguageState] = useState<Language>(() => {
    return initialLanguage ?? adapter.read?.() ?? defaultLanguage;
  });

  // Re-render trigger so consumers see fresh translations once a lazy
  // locale has finished loading. The actual translations live in the
  // module-level cache inside `./locales`.
  const [, setLocaleVersion] = useState(0);

  // Lazy-load the active locale's bundle if it isn't already in memory.
  useEffect(() => {
    if (isLocaleLoaded(language)) return;
    let cancelled = false;
    loadLocale(language).then(() => {
      if (!cancelled) setLocaleVersion((v) => v + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [language]);

  // Post-mount: fall back to browser detection when no caller-supplied
  // language and no stored preference matched. Also wire up subscribe()
  // so cross-tab / OS-level changes propagate.
  useEffect(() => {
    if (initialLanguage) return;
    if (adapter.read?.()) return;
    const detected = detectBrowserLanguage();
    if (detected) {
      setLanguageState(detected);
      adapter.write(detected);
    }
  }, [adapter, initialLanguage]);

  useEffect(() => {
    return adapter.subscribe?.(next => {
      if ((languages as readonly string[]).includes(next)) {
        setLanguageState(next);
      }
    });
  }, [adapter]);

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    adapter.write(lang);
  };

  const value: I18nContextType = {
    language,
    setLanguage,
    t: getLoadedTranslations(language) as TranslationsType,
    plural: (count, forms) => pluralImpl(count, forms, language),
    format: interpolate,
  };

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (context === undefined) {
    throw new Error('useI18n must be used within an I18nProvider');
  }
  return context;
}

export function interpolate(str: string, values: Record<string, unknown>): string {
  return str.replace(/{(\w+)}/g, (match, key) => {
    return values[key] !== undefined ? String(values[key]) : match;
  });
}
