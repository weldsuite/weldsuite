import { stripWorkspacePrefix } from '@/lib/workspace-url';

/**
 * The settings of WeldBooks live in Settings → Apps → WeldBooks, outside the
 * app. Call this from a link or button that leads there, so the back button of
 * Settings returns to the screen the member came from.
 */
export function rememberSettingsReturn(): void {
  try {
    sessionStorage.setItem('settings-return-url', stripWorkspacePrefix(globalThis.location.pathname) || '/');
  } catch {
    // Storage blocked: the back button then falls back to the home screen.
  }
}
