import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { interpolate, plural as pluralFn } from './interpolate';
import { deviceLocale, resolveAppLanguage, type AppLanguage } from './language';
import { en, type Translations } from './locales/en';
import { nl } from './locales/nl';

export const catalogs: Record<AppLanguage, Translations> = { en, nl };

interface I18nContextValue {
  language: AppLanguage;
  t: Translations;
  format: (template: string, values?: Record<string, unknown>) => string;
  plural: (
    count: number,
    forms: { one: string; other: string },
    values?: Record<string, unknown>,
  ) => string;
}

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

/** Provides the catalog for the phone's language (English when unsupported). */
export function I18nProvider({
  children,
  initialLanguage,
}: Readonly<{
  children: ReactNode;
  /** Locale tag override; defaults to the device locale. */
  initialLanguage?: string | null;
}>) {
  const language = resolveAppLanguage(initialLanguage ?? deviceLocale());

  const value = useMemo<I18nContextValue>(
    () => ({
      language,
      t: catalogs[language],
      format: interpolate,
      plural: pluralFn,
    }),
    [language],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useI18n must be used within an I18nProvider');
  }
  return context;
}
