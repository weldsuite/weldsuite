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
}: {
  children: ReactNode;
  initialLanguage?: string | null;
}) {
  const [language, setLanguageState] = useState<AppLanguage>(() =>
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
        setLanguageState(resolved);
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
 * Label lookups fall back to the raw value rather than throwing: these unions
 * are plain `varchar` columns server-side, so a row written by an older client
 * (or by an integration) can carry a value this catalogue has never seen.
 */
export function eventTypeLabel(t: Translations, type: string): string {
  return (t.eventType as Record<string, string>)[type] ?? type;
}

export function statusLabel(t: Translations, status: string): string {
  return (t.status as Record<string, string>)[status] ?? status.replace(/_/g, ' ');
}

export function priorityLabel(t: Translations, priority: string): string {
  return (t.priority as Record<string, string>)[priority] ?? priority;
}

export function permissionLabel(t: Translations, permission: string): string {
  return (t.permission as Record<string, string>)[permission] ?? permission;
}
