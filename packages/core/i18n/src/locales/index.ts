import { en } from './en';

// Default locale (en) is eagerly imported — it's always the fallback for
// `getTranslations()` calls that fire before a non-default locale has
// finished loading. nl + fr + es are lazy-loaded by the provider so consumers
// don't pay their bundle weight unless the user actually picks them.
const localeLoaders = {
  en: () => Promise.resolve(en),
  nl: () => import('./nl').then((m) => m.nl),
  fr: () => import('./fr').then((m) => m.fr),
  es: () => import('./es').then((m) => m.es),
} as const;

export const localeConfig = {
  en: { name: 'English', intlLocale: 'en-US', experimental: false },
  nl: { name: 'Nederlands', intlLocale: 'nl-NL', experimental: false },
  fr: { name: 'Français', intlLocale: 'fr-FR', experimental: true },
  es: { name: 'Español', intlLocale: 'es-ES', experimental: false },
} as const satisfies Record<string, {
  name: string;
  intlLocale: string;
  experimental: boolean;
}>;

export type Language = keyof typeof localeConfig;
export type Translations = typeof en;

export const defaultLanguage: Language = 'en';
export const languages = Object.keys(localeConfig) as Language[];
export const languageNames = Object.fromEntries(
  Object.entries(localeConfig).map(([k, v]) => [k, v.name])
) as Record<Language, string>;

/**
 * Languages safe to surface in user-facing locale pickers. Experimental
 * languages (incomplete translations, [TRANSLATE]/[REVIEW] markers) are
 * filtered out so end users don't see broken UI by accident.
 */
export const stableLanguages = languages.filter(
  l => !localeConfig[l].experimental
) as Language[];

// ─────────────────────────────────────────────────────────────────────────
// Translation loader — keeps the current-locale bundle in a module-level
// cache so the synchronous `getTranslations()` API and the React provider
// can both read from the same source after the active locale has loaded.
// ─────────────────────────────────────────────────────────────────────────

const loadedTranslations: Partial<Record<Language, Translations>> = { en };
const inflightLoads: Partial<Record<Language, Promise<Translations>>> = {};

/**
 * Synchronously read the translations bundle for a locale. Returns the
 * default (`en`) bundle if the requested locale hasn't finished loading
 * yet — call `loadLocale()` first to ensure the right one is present.
 */
export function getLoadedTranslations(locale: Language): Translations {
  return loadedTranslations[locale] ?? en;
}

/**
 * Whether the given locale's translations are already in memory.
 */
export function isLocaleLoaded(locale: Language): boolean {
  return loadedTranslations[locale] !== undefined;
}

/**
 * Load (and cache) a locale's translations. Resolves to the bundle once
 * available. Safe to call repeatedly — concurrent callers share the same
 * in-flight promise.
 */
export function loadLocale(locale: Language): Promise<Translations> {
  if (loadedTranslations[locale]) return Promise.resolve(loadedTranslations[locale] as Translations);
  if (inflightLoads[locale]) return inflightLoads[locale] as Promise<Translations>;

  const loader = localeLoaders[locale];
  const promise = loader().then((bundle) => {
    loadedTranslations[locale] = bundle as Translations;
    delete inflightLoads[locale];
    return bundle as Translations;
  });
  inflightLoads[locale] = promise;
  return promise;
}
