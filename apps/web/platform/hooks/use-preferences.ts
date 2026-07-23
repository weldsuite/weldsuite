
import { useCallback, useSyncExternalStore } from 'react';

// =============================================================================
// Types
// =============================================================================

export type Locale = 'en' | 'nl' | 'fr' | 'de' | 'es';
type Currency = 'USD' | 'EUR' | 'GBP' | 'CAD' | 'AUD';

// =============================================================================
// Cookie helpers
// =============================================================================

const ONE_YEAR = 365 * 24 * 60 * 60;

function getCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

function setCookie(name: string, value: string) {
  if (typeof document === 'undefined') return;
  document.cookie = `${name}=${encodeURIComponent(value)};path=/;max-age=${ONE_YEAR};samesite=lax`;
}

// =============================================================================
// External store subscriptions for SSR-safe reactivity
// =============================================================================

let _localeSnapshot: Locale = 'en';
let _currencySnapshot: Currency = 'USD';
const localeListeners = new Set<() => void>();
const currencyListeners = new Set<() => void>();

function subscribeLocale(cb: () => void) {
  localeListeners.add(cb);
  return () => { localeListeners.delete(cb); };
}

function subscribeCurrency(cb: () => void) {
  currencyListeners.add(cb);
  return () => { currencyListeners.delete(cb); };
}

function getLocaleSnapshot(): Locale {
  if (typeof document !== 'undefined') {
    _localeSnapshot = (getCookie('locale') as Locale) || 'en';
  }
  return _localeSnapshot;
}

function getCurrencySnapshot(): Currency {
  if (typeof document !== 'undefined') {
    _currencySnapshot = (getCookie('currency') as Currency) || 'USD';
  }
  return _currencySnapshot;
}

function getLocaleServerSnapshot(): Locale {
  return 'en';
}

function getCurrencyServerSnapshot(): Currency {
  return 'USD';
}

// =============================================================================
// Hooks
// =============================================================================

/**
 * Client-side locale preference backed by a cookie.
 * Replaces the server action `setLanguage` / `getLanguage`.
 */
export function useLocale() {
  const locale = useSyncExternalStore(subscribeLocale, getLocaleSnapshot, getLocaleServerSnapshot);

  const setLocale = useCallback((newLocale: Locale) => {
    setCookie('locale', newLocale);
    _localeSnapshot = newLocale;
    localeListeners.forEach((cb) => cb());
    // Reload so server components pick up the new cookie
    window.location.reload();
  }, []);

  return { locale, setLocale };
}

/**
 * Client-side currency preference backed by a cookie.
 * Replaces the server action `setCurrency` / `getCurrency`.
 */
function useCurrency() {
  const currency = useSyncExternalStore(subscribeCurrency, getCurrencySnapshot, getCurrencyServerSnapshot);

  const setCurrencyValue = useCallback((newCurrency: Currency) => {
    setCookie('currency', newCurrency);
    _currencySnapshot = newCurrency;
    currencyListeners.forEach((cb) => cb());
    // Reload so server components pick up the new cookie
    window.location.reload();
  }, []);

  return { currency, setCurrency: setCurrencyValue };
}
