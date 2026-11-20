/**
 * Replenishment's settings and CSV import live in Settings > Apps > WeldStash
 * (AGENTS.md: an app's settings have one home). The Replenishment section links
 * there; the Settings back button returns to the page the person was on.
 */

import { stripWorkspacePrefix } from '@/lib/workspace-url';

export const WELDSTASH_SETTINGS_PATH = '/settings/apps/weldstash';

export function openWeldStashSettings(router: { push: (href: string) => void }): void {
  try {
    sessionStorage.setItem('settings-return-url', stripWorkspacePrefix(globalThis.location.pathname));
  } catch {
    // Storage can be blocked; the link still works, the back button just goes to the default.
  }
  router.push(WELDSTASH_SETTINGS_PATH);
}
