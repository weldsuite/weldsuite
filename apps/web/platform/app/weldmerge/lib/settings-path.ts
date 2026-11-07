/**
 * WeldMerge's settings live with the other apps in workspace Settings
 * (Settings → Apps → WeldMerge). `/weldmerge/settings` redirects here, so links
 * merge-api still builds to the old path keep working.
 */
export const WELDMERGE_SETTINGS_PATH = '/settings/apps/weldmerge';

/** A settings tab, as the OAuth and GitHub install round trips return to it. */
export const weldmergeSettingsTab = (tab: 'providers' | 'accounts') => `${WELDMERGE_SETTINGS_PATH}?tab=${tab}`;

export interface WeldMergeSettingsSearch {
  installed?: string;
  tab?: string;
  error?: string;
}

/**
 * `?installed=1` is where the GitHub App installation returns to; the page then retries the connection.
 * `?tab=` opens a section (the OAuth callback returns to `providers` or `accounts`).
 * `?error=` is a refused GitHub installation (`state_expired`, `installation_unverified`, …).
 */
export const validateWeldMergeSettingsSearch = (search: Record<string, unknown>): WeldMergeSettingsSearch => ({
  installed: typeof search.installed === 'string' || typeof search.installed === 'number' ? String(search.installed) : undefined,
  tab: typeof search.tab === 'string' ? search.tab : undefined,
  error: typeof search.error === 'string' ? search.error : undefined,
});
