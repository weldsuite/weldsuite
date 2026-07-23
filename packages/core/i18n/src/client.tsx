/**
 * Client-side React hook for the platform SPA (apps/web/platform).
 *
 * `useTranslations()` returns a `t(key, params?)` function where `key` is a
 * dot-separated path into the full translations tree (e.g. 'crm.customers.title').
 * This is the eager counterpart to the lazy `useTranslations(ns)` in
 * lazy-provider.tsx — the platform loads all translations upfront and accesses
 * them synchronously, which avoids Suspense waterfalls when many namespaces are
 * needed simultaneously.
 *
 * Usage:
 *   const t = useTranslations();
 *   t('crm.customers.title')                    // → "Customers"
 *   t('common.with.params', { count: 3 })       // → "3 items"
 */

import { useI18n } from './provider';
import { createTranslator } from './index';

/**
 * Hook that returns a dot-path translator function backed by the current locale.
 * Must be rendered inside `<I18nProvider>`.
 *
 * @returns `t(path, params?)` — navigates the full translation tree by dot-path
 * and interpolates `{param}` placeholders.
 */
export function useTranslations(): (path: string, params?: Record<string, unknown>) => string {
  const { t } = useI18n();
  return createTranslator(t as unknown as Record<string, unknown>);
}
