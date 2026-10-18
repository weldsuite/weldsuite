/**
 * Platform-aware keyboard shortcut labels.
 *
 * Shortcuts are written once with a platform-neutral modifier token (`mod`,
 * `shift`, `alt`) and rendered per platform: `mod` is Command on Apple
 * platforms and Control everywhere else.
 *
 *   formatShortcut(['mod', 'K'], true)   // "⌘K"
 *   formatShortcut(['mod', 'K'], false)  // "Ctrl+K"
 */

export type ShortcutModifier = 'mod' | 'shift' | 'alt';

const MAC_PATTERN = /mac|iphone|ipad|ipod/i;

interface NavigatorWithUAData {
  platform?: string;
  userAgent?: string;
  userAgentData?: { platform?: string };
}

/** True on macOS and iOS/iPadOS (where hardware keyboards use Command). */
function currentNavigator(): NavigatorWithUAData | null {
  return typeof navigator === 'undefined' ? null : (navigator as NavigatorWithUAData);
}

export function isMacPlatform(nav?: NavigatorWithUAData | null): boolean {
  const source = nav === undefined ? currentNavigator() : nav;
  if (!source) return false;
  const platform = source.userAgentData?.platform || source.platform || source.userAgent || '';
  return MAC_PATTERN.test(platform);
}

const MAC_LABELS: Record<ShortcutModifier, string> = { mod: '⌘', shift: '⇧', alt: '⌥' };
const OTHER_LABELS: Record<ShortcutModifier, string> = { mod: 'Ctrl', shift: 'Shift', alt: 'Alt' };

const isModifier = (token: string): token is ShortcutModifier => token === 'mod' || token === 'shift' || token === 'alt';

/** One label per token: modifiers per platform, other keys as given. */
export function shortcutKeyLabels(keys: readonly string[], mac: boolean = isMacPlatform()): string[] {
  const labels = mac ? MAC_LABELS : OTHER_LABELS;
  return keys.map((key) => (isModifier(key) ? labels[key] : key));
}

/** A shortcut as one string: "⌘K" on Mac, "Ctrl+K" elsewhere. */
export function formatShortcut(keys: readonly string[], mac: boolean = isMacPlatform()): string {
  return shortcutKeyLabels(keys, mac).join(mac ? '' : '+');
}
