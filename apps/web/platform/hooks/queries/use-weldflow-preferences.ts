import { useCallback } from 'react';
import { useUserPreferences } from './use-settings-queries';
import { useUiPreferenceMutation } from './use-ui-preference';

/**
 * Which project tabs the user shows, and in what order. `tabIds` is `null` until
 * the user changes it (callers fall back to the default set). Shared by every
 * project, so hiding or moving a tab does not depend on which project is open.
 */
export function useProjectTabPreference() {
  const { data } = useUserPreferences();
  const mutation = useUiPreferenceMutation('weldflowProjectTabs');
  const { mutate } = mutation;
  const setTabIds = useCallback((ids: string[]) => mutate(ids), [mutate]);
  return { tabIds: data?.uiPreferences?.weldflowProjectTabs ?? null, setTabIds };
}

/** The user's own order of the projects in the WeldFlow sidebar (project ids). */
export function useSidebarProjectOrder() {
  const { data } = useUserPreferences();
  const mutation = useUiPreferenceMutation('weldflowSidebarProjectOrder');
  const { mutate } = mutation;
  const setOrder = useCallback((ids: string[]) => mutate(ids), [mutate]);
  return { order: data?.uiPreferences?.weldflowSidebarProjectOrder ?? null, setOrder, isLoaded: data !== undefined };
}
