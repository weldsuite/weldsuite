import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { preferencesKey, useUserPreferences, type UserPreferences } from './use-settings-queries';

type UiPreferences = NonNullable<UserPreferences['uiPreferences']>;

/**
 * Writes one key of `uiPreferences` (the server merges it into the stored
 * JSONB, so sibling keys survive). Patches the cache first so a drag-and-drop
 * reorder feels instant; rolls back on error.
 */
export function useUiPreferenceMutation<K extends keyof UiPreferences>(key: K) {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (value: UiPreferences[K]) => {
      const client = await getClient();
      return client.put<{ data: UserPreferences }>('/user-preferences', {
        uiPreferences: { [key]: value },
      });
    },
    onMutate: async (value) => {
      await qc.cancelQueries({ queryKey: preferencesKey });
      const previous = qc.getQueryData<UserPreferences>(preferencesKey);
      if (previous) {
        qc.setQueryData<UserPreferences>(preferencesKey, {
          ...previous,
          uiPreferences: { ...previous.uiPreferences, [key]: value },
        });
      }
      return { previous };
    },
    onError: (_err, _value, ctx) => {
      if (ctx?.previous) qc.setQueryData(preferencesKey, ctx.previous);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: preferencesKey });
    },
  });
}

/**
 * The user's order of the apps in the far-left rail (app codes, uninstalled
 * ones included so a reinstalled app returns to its slot). `order` is `null`
 * until the preferences have loaded or when the user never reordered.
 */
export function useSidebarAppOrder() {
  const { data } = useUserPreferences();
  const { mutate } = useUiPreferenceMutation('sidebarAppOrder');
  const setOrder = useCallback((codes: string[]) => mutate(codes), [mutate]);
  const saved = data?.uiPreferences?.sidebarAppOrder;
  return { order: Array.isArray(saved) ? saved : null, setOrder, isLoaded: data !== undefined };
}

/** WeldChat sidebar: the user's drag-and-drop order per group (group key → channel ids). */
export function useWeldchatSidebarOrder() {
  const { data } = useUserPreferences();
  const { mutate } = useUiPreferenceMutation('weldchatSidebarOrder');
  const order = data?.uiPreferences?.weldchatSidebarOrder ?? EMPTY_ORDER;
  // The server replaces the whole key, so a group's new order is written with
  // every other group's order next to it.
  const setGroupOrder = useCallback(
    (groupKey: string, ids: string[]) => mutate({ ...order, [groupKey]: ids }),
    [mutate, order],
  );
  return { order, setGroupOrder };
}

const EMPTY_ORDER: Record<string, string[]> = {};
