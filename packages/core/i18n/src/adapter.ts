import type { Language } from './locales';

/**
 * Locale source/sink for an I18nProvider.
 *
 * Different runtimes (web cookie, mobile AsyncStorage, Next.js request headers)
 * resolve and persist locale differently. The provider stays runtime-agnostic
 * and delegates to whichever adapter is injected.
 *
 * Conventions:
 * - `read()` is synchronous and may return `undefined` if no preference is
 *   stored. Async sources (AsyncStorage) should resolve outside the adapter
 *   and pass the value through `initialLanguage` instead.
 * - `write()` is synchronous; async persistence should fire-and-forget.
 * - `subscribe()` is for cross-context updates (other tabs, OS-level locale
 *   change). Calling the returned function unsubscribes.
 */
export interface LocaleAdapter {
  read?(): Language | undefined;
  write(locale: Language): void;
  subscribe?(callback: (locale: Language) => void): () => void;
}
