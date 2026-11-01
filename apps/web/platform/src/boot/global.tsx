/**
 * Global boot (`VITE_RUNTIME_CONFIG` unset or `off`, see `./mode.ts`): the app
 * is imported statically, so it ships in the entry chunk, and no
 * `/config.json` is requested. Clerk is the identity provider.
 */
import { getLocale } from '@weldsuite/i18n';
import { loadLocale } from '@weldsuite/i18n/locales';
import { renderApp } from '../app';

/**
 * Render once the stored locale's bundle is in. Non-English bundles are lazy
 * chunks and many screens read translations synchronously
 * (`getTranslations()`), which never re-renders when a bundle lands later. A
 * failed load falls back to English.
 */
export async function startApp(): Promise<void> {
  await loadLocale(getLocale()).catch(() => undefined);
  renderApp();
}
