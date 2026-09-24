'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { Dictionary } from './en';
import { format } from './format';
import { dictionaries, LOCALE_COOKIE, TIMEZONE_COOKIE, type Locale } from './locale';

interface I18nContextValue {
  locale: Locale;
  /** IANA zone every date/time is rendered in — identical on the server and in the browser, so hydration matches. */
  timeZone: string;
  dict: Dictionary;
  setLocale: (locale: Locale) => void;
  format: typeof format;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({
  initialLocale,
  timeZone,
  children,
}: {
  initialLocale: Locale;
  timeZone: string;
  children: ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
    } catch {
      // Browser storage can throw in private/locked-down contexts — the
      // in-memory locale still applies for the rest of this session.
    }
  }, []);

  const value = useMemo<I18nContextValue>(
    () => ({ locale, timeZone, dict: dictionaries[locale], setLocale, format }),
    [locale, timeZone, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within an I18nProvider');
  return ctx;
}

/**
 * Tells the server the browser's time zone. When the zone the page was
 * rendered in differs (first visit, travelling), store the real one and
 * re-render once on the server so times show in local time.
 */
export function TimeZoneSync() {
  const { timeZone } = useI18n();
  const router = useRouter();

  useEffect(() => {
    let browserZone: string;
    try {
      browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return;
    }
    if (!browserZone || browserZone === timeZone) return;
    try {
      document.cookie = `${TIMEZONE_COOKIE}=${encodeURIComponent(browserZone)}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
    } catch {
      return;
    }
    router.refresh();
  }, [timeZone, router]);

  return null;
}
