/** The tabs of the module-level settings page and how `?tab=` is read. */

export const SETTINGS_TABS = ['usage'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** Router `validateSearch`: an unknown tab is dropped, which opens the first. */
export function parseSettingsSearch(raw: Record<string, unknown>): { tab?: SettingsTab } {
  return SETTINGS_TABS.includes(raw.tab as SettingsTab) ? { tab: raw.tab as SettingsTab } : {};
}
