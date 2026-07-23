import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { defaultLanguage, languages, type Language } from './locales';
import type { LocaleAdapter } from './adapter';
import { cookieAdapter } from './adapters/cookie';
import { readNamespace, type NamespaceName } from './lazy';
import type { TranslationNamespaces } from './types';

interface LazyI18nContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
}

const LazyI18nContext = createContext<LazyI18nContextType | undefined>(undefined);

interface LazyI18nProviderProps {
  children: ReactNode;
  initialLanguage?: Language;
  adapter?: LocaleAdapter;
}

/**
 * Lightweight provider for consumers that want to lazy-load namespaces
 * (Next.js apps, mobile). Unlike `I18nProvider`, this one does NOT pull the
 * entire translations bundle into its context value — namespaces are fetched
 * on demand via `useTranslations(ns)`.
 *
 * Pair with `useTranslations(ns)` inside a `<Suspense>` boundary at the
 * route or screen level.
 */
export function LazyI18nProvider({
  children,
  initialLanguage,
  adapter = cookieAdapter,
}: LazyI18nProviderProps) {
  const [language, setLanguageState] = useState<Language>(() => {
    return initialLanguage ?? adapter.read?.() ?? defaultLanguage;
  });

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

  return (
    <LazyI18nContext.Provider value={{ language, setLanguage }}>
      {children}
    </LazyI18nContext.Provider>
  );
}

export function useLazyI18n(): LazyI18nContextType {
  const context = useContext(LazyI18nContext);
  if (context === undefined) {
    throw new Error('useLazyI18n / useTranslations must be used within a LazyI18nProvider');
  }
  return context;
}

/**
 * Suspense-based namespace hook. Suspends on the first read until the
 * namespace chunk is fetched, then returns the deeply-typed translations
 * object for that namespace.
 *
 *   function HelpdeskPage() {
 *     const t = useTranslations('helpdesk');
 *     return <h1>{t.news.title}</h1>;
 *   }
 *
 *   <Suspense fallback={<Skeleton />}>
 *     <HelpdeskPage />
 *   </Suspense>
 *
 * Implementation: portable across React 18.0+ and React 19 — uses the manual
 * throw-the-promise pattern via `readNamespace`. React 19's `use()` works
 * too but isn't required.
 */
export function useTranslations<NS extends NamespaceName>(ns: NS): TranslationNamespaces[NS] {
  const { language } = useLazyI18n();
  return readNamespace(language, ns);
}
