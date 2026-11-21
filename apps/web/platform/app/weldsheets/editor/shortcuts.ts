/** True on Apple platforms, where shortcuts read as symbols (⌘B) rather than words (Ctrl+B). */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform ?? nav.platform ?? '');
}

const MAC_MODIFIERS: Record<string, { symbol: string; order: number }> = {
  ctrl: { symbol: '⌃', order: 0 },
  alt: { symbol: '⌥', order: 1 },
  shift: { symbol: '⇧', order: 2 },
  mod: { symbol: '⌘', order: 3 },
};

const OTHER_MODIFIERS: Record<string, string> = { mod: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' };

/**
 * Writes a shortcut for the platform. The spec is modifiers and a key joined by
 * "+", where `Mod` is ⌘ on a Mac and Ctrl elsewhere: `formatShortcut('Mod+Shift+Z')`
 * gives "⇧⌘Z" on a Mac and "Ctrl+Shift+Z" elsewhere. A key of "+" is written "Plus".
 */
export function formatShortcut(spec: string, mac: boolean = isApplePlatform()): string {
  const parts = spec.split('+').map((p) => (p === 'Plus' ? '+' : p));
  const key = parts.pop() ?? '';
  const mods = parts.map((p) => p.toLowerCase()).filter((p) => p in MAC_MODIFIERS);
  const keyText = key.length === 1 ? key.toUpperCase() : key;
  if (mac) {
    const symbols = mods.sort((a, b) => MAC_MODIFIERS[a].order - MAC_MODIFIERS[b].order).map((m) => MAC_MODIFIERS[m].symbol);
    return `${symbols.join('')}${keyText}`;
  }
  return [...mods.map((m) => OTHER_MODIFIERS[m]), keyText].join('+');
}
