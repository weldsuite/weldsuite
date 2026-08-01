import type { Language } from './locales';
import type { TranslationNamespaces } from './types';

export type NamespaceName = keyof TranslationNamespaces;

type CacheEntry<T> = {
  status: 'pending' | 'success' | 'error';
  value?: T;
  error?: unknown;
  promise: Promise<T>;
};

const cache = new Map<string, CacheEntry<unknown>>();

function cacheKey(locale: Language, ns: NamespaceName): string {
  return `${locale}:${String(ns)}`;
}

/**
 * Dynamically import a single locale namespace. The dynamic-import template
 * is `./locales/${locale}/${ns}.ts` — both Vite and webpack / turbopack
 * statically analyze this pattern and code-split per locale × namespace, so
 * consumers ship only the slices they actually use.
 *
 * Use cases:
 * - Next.js Server Components: `const helpdesk = await loadNamespace('en', 'helpdesk');`
 * - React Native (Expo): same, awaited at the screen level.
 *
 * The Vite SPA at apps/web/platform should stay on the eager `useI18n()` path —
 * its dashboard touches 8+ namespaces simultaneously, so lazy adds a network
 * waterfall with no win.
 */
export async function loadNamespace<NS extends NamespaceName>(
  locale: Language,
  ns: NS
): Promise<TranslationNamespaces[NS]> {
  const key = cacheKey(locale, ns);
  let entry = cache.get(key) as CacheEntry<TranslationNamespaces[NS]> | undefined;
  if (entry) return entry.promise;

  const promise = import(`./locales/${locale}/${String(ns)}.ts`).then(
    mod => mod[String(ns)] as TranslationNamespaces[NS]
  );
  entry = { status: 'pending', promise };
  cache.set(key, entry as CacheEntry<unknown>);
  promise.then(
    value => {
      entry!.status = 'success';
      entry!.value = value;
    },
    error => {
      entry!.status = 'error';
      entry!.error = error;
    }
  );
  return promise;
}

/**
 * Fire-and-forget preload. Useful for warming the cache on route hover or
 * during idle time so the suspense boundary in `useTranslations()` never
 * actually suspends.
 */
export function preloadNamespace<NS extends NamespaceName>(locale: Language, ns: NS): void {
  void loadNamespace(locale, ns);
}

/**
 * Reset the namespace cache. Test-only — production code should never call
 * this since cache invalidation across React trees is fiddly.
 */
export function __clearNamespaceCache(): void {
  cache.clear();
}

/**
 * Internal read-or-suspend used by useTranslations(). Exposed so a consumer
 * can build their own suspense hook on top if useTranslations()'s context
 * dependency doesn't fit.
 */
export function readNamespace<NS extends NamespaceName>(
  locale: Language,
  ns: NS
): TranslationNamespaces[NS] {
  const key = cacheKey(locale, ns);
  let entry = cache.get(key) as CacheEntry<TranslationNamespaces[NS]> | undefined;
  if (!entry) {
    // Trigger the load (and cache it) — `loadNamespace` populates the entry
    // synchronously even though it returns a promise.
    void loadNamespace(locale, ns);
    entry = cache.get(key) as CacheEntry<TranslationNamespaces[NS]>;
  }
  if (entry.status === 'success') return entry.value as TranslationNamespaces[NS];
  if (entry.status === 'error') throw entry.error;
  throw entry.promise;
}
