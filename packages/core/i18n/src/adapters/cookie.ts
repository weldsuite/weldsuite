import type { LocaleAdapter } from '../adapter';
import { languages, type Language } from '../locales';

const COOKIE_NAME = 'locale';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

function isProductionEnv(): boolean {
  // `process.env.NODE_ENV` is statically replaced by Vite / Next.js / webpack
  // at build time. Read via globalThis so the package doesn't need @types/node.
  const g = globalThis as { process?: { env?: { NODE_ENV?: string } } };
  return g.process?.env?.NODE_ENV === 'production';
}

/**
 * Default web adapter: reads/writes a `locale` cookie on `document.cookie`.
 * No-op when `document` is unavailable (SSR, RN, workers).
 */
export const cookieAdapter: LocaleAdapter = {
  read() {
    if (typeof document === 'undefined') return undefined;
    const match = document.cookie.match(new RegExp(`(?:^|; )${COOKIE_NAME}=([^;]*)`));
    if (!match || match[1] === undefined) return undefined;
    const decoded = decodeURIComponent(match[1]);
    return (languages as readonly string[]).includes(decoded) ? (decoded as Language) : undefined;
  },
  write(locale) {
    if (typeof document === 'undefined') return;
    const secure = isProductionEnv() ? '; Secure' : '';
    document.cookie = `${COOKIE_NAME}=${locale}; path=/; max-age=${MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
  },
};
