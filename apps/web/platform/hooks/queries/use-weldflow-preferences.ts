import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { preferencesKey, useUserPreferences, type UserPreferences } from './use-settings-queries';

/** The WeldFlow slice of `user_preferences.uiPreferences` (per user, per workspace). */
type WeldflowUiPreferenceKey = 'weldflowProjectTabs' | 'weldflowSidebarProjectOrder';

// Writes one WeldFlow key of uiPreferences (the server merges it into the stored
// JSONB). Patches the cache first so reorders feel instant; rolls back on error.
function useWeldflowPreferenceMutation(key: WeldflowUiPreferenceKey) {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      const client = await getClient();
      return client.put<{ data: UserPreferences }>('/user-preferences', {
        uiPreferences: { [key]: ids },
      });
    },
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: preferencesKey });
      const previous = qc.getQueryData<UserPreferences>(preferencesKey);
      if (previous) {
        qc.setQueryData<UserPreferences>(preferencesKey, {
          ...previous,
          uiPreferences: { ...previous.uiPreferences, [key]: ids },
        });
      }
      return { previous };
    },
    onError: (_err, _ids, ctx) => {
      if (ctx?.previous) qc.setQueryData(preferencesKey, ctx.previous);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: preferencesKey });
    },
  });
}

/**
 * Which project tabs the user shows, and in what order. `tabIds` is `null` until
 * the user changes it (callers fall back to the default set). Shared by every
 * project, so hiding or moving a tab does not depend on which project is open.
 */
export function useProjectTabPreference() {
  const { data } = useUserPreferences();
  const mutation = useWeldflowPreferenceMutation('weldflowProjectTabs');
  const { mutate } = mutation;
  const setTabIds = useCallback((ids: string[]) => mutate(ids), [mutate]);
  return { tabIds: data?.uiPreferences?.weldflowProjectTabs ?? null, setTabIds };
}

/** The user's own order of the projects in the WeldFlow sidebar (project ids). */
export function useSidebarProjectOrder() {
  const { data } = useUserPreferences();
  const mutation = useWeldflowPreferenceMutation('weldflowSidebarProjectOrder');
  const { mutate } = mutation;
  const setOrder = useCallback((ids: string[]) => mutate(ids), [mutate]);
  return { order: data?.uiPreferences?.weldflowSidebarProjectOrder ?? null, setOrder, isLoaded: data !== undefined };
}
