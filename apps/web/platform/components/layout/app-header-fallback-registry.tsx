/**
 * Path-segment label registry — used as a fallback when a route has no
 * `staticData.breadcrumb` and no loader-supplied label. Built from the same
 * MODULE_CONFIGS used by the sidebar so we don't duplicate the source of truth.
 */

import { useMemo } from 'react';
import { MODULE_CONFIGS } from './module-sidebar-configs';
import { useI18n } from '@/lib/i18n/provider';

type MenuLeaf = { href?: string; title: string };
type MenuGroups = ReturnType<(typeof MODULE_CONFIGS)[keyof typeof MODULE_CONFIGS]['getMenuItems']>;

function addMenuItem(map: Map<string, string>, item: MenuLeaf | undefined): void {
  if (item?.href) map.set(item.href, item.title);
  // also add nested children if present
  const subItems = (item as unknown as { items?: MenuLeaf[] } | undefined)?.items;
  if (!Array.isArray(subItems)) return;
  for (const sub of subItems) {
    if (sub.href) map.set(sub.href, sub.title);
  }
}

function addMenuGroups(map: Map<string, string>, groups: MenuGroups): void {
  for (const group of groups) {
    for (const item of group.items ?? []) {
      addMenuItem(map, item as MenuLeaf | undefined);
    }
  }
}

export function useFallbackLabelRegistry(): Map<string, string> {
  const { t } = useI18n();
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const config of Object.values(MODULE_CONFIGS)) {
      addMenuGroups(map, config.getMenuItems(t));
    }
    return map;
  }, [t]);
}
