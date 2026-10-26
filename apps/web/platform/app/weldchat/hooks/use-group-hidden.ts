import { useQueryClient } from '@tanstack/react-query';
import {
  preferencesKey,
  useUpdateUserPreferences,
  useUserPreferences,
  type UserPreferences,
} from '@/hooks/queries/use-settings-queries';
import { withGroupHidden, type WeldchatGroupFilters } from '../lib/group-filter';

/** `uiPreferences` with the WeldChat group settings, which the shared type leaves out. */
type UiPreferencesWithGroupFilters = NonNullable<UserPreferences['uiPreferences']> & {
  weldchatGroupFilters?: WeldchatGroupFilters;
};

function groupFiltersOf(prefs: UserPreferences | undefined): WeldchatGroupFilters {
  return (prefs?.uiPreferences as UiPreferencesWithGroupFilters | undefined)?.weldchatGroupFilters ?? {};
}

/**
 * Whether a WeldChat sidebar group is hidden ("Hide this group"), and the
 * switch that hides or shows it again: the sidebar's group menu and its Undo,
 * and the record chats page's "Show in sidebar".
 */
export function useGroupHidden(): {
  isGroupHidden: (groupKey: string) => boolean;
  setGroupHidden: (groupKey: string, hidden: boolean) => void;
} {
  const queryClient = useQueryClient();
  const { data: prefs } = useUserPreferences();
  const { mutate: updateUserPreferences } = useUpdateUserPreferences();

  const isGroupHidden = (groupKey: string) => !!groupFiltersOf(prefs)[groupKey]?.hidden;

  /**
   * Builds on the preferences in the cache at click time, not on this
   * render's: the server replaces `weldchatGroupFilters` as a whole, so an
   * Undo clicked after another hide (or a settings save) must not bring back
   * what changed since. The cache is written first, so a second click right
   * away sees the first.
   */
  const setGroupHidden = (groupKey: string, hidden: boolean) => {
    const current = queryClient.getQueryData<UserPreferences>(preferencesKey);
    const weldchatGroupFilters = withGroupHidden(groupFiltersOf(current), groupKey, hidden);
    if (current) {
      queryClient.setQueryData<UserPreferences>(preferencesKey, {
        ...current,
        uiPreferences: { ...current.uiPreferences, weldchatGroupFilters } as UiPreferencesWithGroupFilters,
      });
    }
    updateUserPreferences(
      { uiPreferences: { weldchatGroupFilters } as UiPreferencesWithGroupFilters },
      { onError: () => queryClient.invalidateQueries({ queryKey: preferencesKey }) },
    );
  };

  return { isGroupHidden, setGroupHidden };
}
