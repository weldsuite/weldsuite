/**
 * Per-project collector and privacy settings, and their defaults.
 *
 * The shape is `panel_projects.settings` (packages/core/db/src/schema/weldpanel.ts);
 * the same value is copied into the master registry and the KV record the
 * collector reads (./registry).
 */

import type { PanelProjectSettings } from '@weldsuite/db/schema';

export type { PanelProjectSettings };

/**
 * New projects: autocapture on, balanced masking, cookieless until consent,
 * every consented session recorded (recordings arrive in phase 4), AI on.
 */
export const DEFAULT_PANEL_SETTINGS: PanelProjectSettings = {
  autocapture: true,
  maskingLevel: 'balanced',
  consentMode: 'required',
  recordingSampleRate: 1,
  excludedUrls: [],
  ipFilters: [],
  aiEnabled: true,
};

/** Fills settings stored before a field existed with its default. */
export function withSettingDefaults(settings: Partial<PanelProjectSettings> | null | undefined): PanelProjectSettings {
  return { ...DEFAULT_PANEL_SETTINGS, ...(settings ?? {}) };
}
