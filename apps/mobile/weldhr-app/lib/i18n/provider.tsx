import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

import { interpolate, plural as pluralFn } from './interpolate';
import {
  INTL_LOCALES,
  type AppLanguage,
  resolveAppLanguage,
} from './language';
import { en, type Translations } from './locales/en';
import { nl } from './locales/nl';
import { persistLanguage } from './storage';

const catalogs: Record<AppLanguage, Translations> = { en, nl };

interface I18nContextValue {
  language: AppLanguage;
  intlLocale: string;
  t: Translations;
  setLanguage: (language: AppLanguage) => void;
  format: (template: string, values?: Record<string, unknown>) => string;
  plural: (
    count: number,
    forms: { one: string; other: string },
    values?: Record<string, unknown>,
  ) => string;
}

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

export function I18nProvider({
  children,
  initialLanguage,
}: Readonly<{
  children: ReactNode;
  initialLanguage?: string | null;
}>) {
  const [language, setLanguage] = useState<AppLanguage>(() =>
    resolveAppLanguage(initialLanguage),
  );

  const value = useMemo<I18nContextValue>(() => {
    const t = catalogs[language];
    return {
      language,
      intlLocale: INTL_LOCALES[language],
      t,
      setLanguage: (next) => {
        const resolved = resolveAppLanguage(next);
        setLanguage(resolved);
        void persistLanguage(resolved);
      },
      format: interpolate,
      plural: pluralFn,
    };
  }, [language]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useI18n must be used within an I18nProvider');
  }
  return context;
}

/**
 * Statuses and categories are enums server-side that can grow, so a value this
 * catalog has never seen falls back to the raw value, readable but untranslated.
 */
export function labelFor(labels: Readonly<Record<string, string>>, status: string): string {
  const known = labels[status];
  if (known) return known;
  const spaced = status.replaceAll('_', ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
