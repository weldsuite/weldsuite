/**
 * Per-user, per-workspace tab visibility config for object panels.
 *
 * Persists `{ [tabId]: boolean }` overrides into the settings worker via
 * the existing `useGridViewSettings` / `useUpdateGridView` hooks
 * (`/settings/grid-views/:gridName`). The grid name is namespaced as
 * `panel-tabs:<objectType>:<mode>` so panel mode and fullscreen mode each
 * keep their own preference set.
 *
 * Tabs marked `required: true` are always visible and cannot be toggled
 * off. Tabs missing from the saved overrides fall back to
 * `defaultVisible` from the descriptor.
 */

import { useCallback, useMemo } from 'react';
import {
  useGridViewSettings,
  useUpdateGridView,
} from '@/hooks/queries/use-settings-queries';

interface ObjectPanelTabConfigEntry {
  id: string;
  label: string;
  defaultVisible: boolean;
  required?: boolean;
}

export interface UseObjectPanelTabConfigOptions {
  objectType: string;
  mode: 'panel' | 'fullscreen' | string;
  tabs: ObjectPanelTabConfigEntry[];
}

export function useObjectPanelTabConfig({
  objectType,
  mode,
  tabs,
}: UseObjectPanelTabConfigOptions) {
  const gridName = `panel-tabs:${objectType}:${mode}`;

  const { data, isLoading } = useGridViewSettings(gridName);
  const updateMutation = useUpdateGridView();

  const visibility = useMemo(() => {
    const saved = data?.columnVisibility;
    const next: Record<string, boolean> = {};
    for (const tab of tabs) {
      if (tab.required) {
        next[tab.id] = true;
      } else if (saved && tab.id in saved) {
        next[tab.id] = saved[tab.id];
      } else {
        next[tab.id] = tab.defaultVisible;
      }
    }
    return next;
  }, [data, tabs]);

  const isVisible = useCallback(
    (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId);
      if (tab?.required) return true;
      return visibility[tabId] ?? false;
    },
    [visibility, tabs],
  );

  const toggle = useCallback(
    (tabId: string) => {
      const tab = tabs.find((t) => t.id === tabId);
      if (tab?.required) return;
      const next = { ...visibility, [tabId]: !visibility[tabId] };
      updateMutation.mutate({
        gridName,
        data: {
          columnVisibility: next,
          columnWidths: data?.columnWidths ?? {},
        },
      });
    },
    [visibility, tabs, gridName, data, updateMutation],
  );

  const resetToDefaults = useCallback(() => {
    const defaults: Record<string, boolean> = {};
    for (const tab of tabs) {
      defaults[tab.id] = tab.required || tab.defaultVisible;
    }
    updateMutation.mutate({
      gridName,
      data: {
        columnVisibility: defaults,
        columnWidths: data?.columnWidths ?? {},
      },
    });
  }, [tabs, gridName, data, updateMutation]);

  return {
    visibility,
    isVisible,
    toggle,
    resetToDefaults,
    isLoading,
  };
}
