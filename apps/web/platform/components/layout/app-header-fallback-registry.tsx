/**
 * Path-segment label registry — used as a fallback when a route has no
 * `staticData.breadcrumb` and no loader-supplied label. Built from the same
 * MODULE_CONFIGS used by the sidebar so we don't duplicate the source of truth.
 */

import { useMemo } from 'react';
import { MODULE_CONFIGS } from './module-sidebar-configs';
import { useI18n } from '@/lib/i18n/provider';

export function useFallbackLabelRegistry(): Map<string, string> {
  const { t } = useI18n();
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const config of Object.values(MODULE_CONFIGS)) {
      const groups = config.getMenuItems(t);
      for (const group of groups) {
        for (const item of group.items ?? []) {
          if (item?.href) map.set(item.href, item.title);
          // also add nested children if present
          const subItems = (item as unknown as { items?: Array<{ href?: string; title: string }> })?.items;
          if (Array.isArray(subItems)) {
            for (const sub of subItems) {
              if (sub.href) map.set(sub.href, sub.title);
            }
          }
        }
      }
    }
    return map;
  }, [t]);
}
