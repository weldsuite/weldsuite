/**
 * The keyboard shortcuts the platform actually registers.
 *
 * One list, two readers: the listeners (command palette, settings, shortcuts
 * help, WeldAgent) match key events against these bindings, and Settings ›
 * Keyboard Shortcuts renders the same entries. A shortcut that is not in here
 * is not registered, so the page cannot list one that does nothing.
 *
 * Keep to combinations a web page can actually claim: the browser keeps
 * Ctrl/Cmd+N, T, W, L, D, R, Shift+N/W and Ctrl+1..9 for itself, so
 * `preventDefault` never reaches them.
 */

export type HotkeyId =
  | 'openCommandPalette'
  | 'openSettings'
  | 'showKeyboardShortcuts'
  | 'toggleWeldAgent'
  | 'closeDialogPanel'
  | 'sendOrSubmit';

export type HotkeyCategory = 'general' | 'writing';

export interface HotkeyBinding {
  /** `KeyboardEvent.key`, compared case-insensitively. */
  key: string;
  /** Command on Apple platforms, Control elsewhere (either is accepted). */
  mod?: boolean;
  /** When omitted, Shift is not checked (so `?` works on any layout). */
  shift?: boolean;
  alt?: boolean;
}

export interface HotkeyDefinition {
  id: HotkeyId;
  category: HotkeyCategory;
  binding: HotkeyBinding;
  /** A second binding for the same action. */
  alternate?: HotkeyBinding;
  /**
   * `global` shortcuts work anywhere in the app; `contextual` ones only inside
   * the surface that handles them (e.g. a message composer).
   */
  scope: 'global' | 'contextual';
}

export const HOTKEYS: Record<HotkeyId, HotkeyDefinition> = {
  openCommandPalette: {
    id: 'openCommandPalette',
    category: 'general',
    scope: 'global',
    binding: { key: 'k', mod: true },
  },
  openSettings: {
    id: 'openSettings',
    category: 'general',
    scope: 'global',
    binding: { key: ',', mod: true },
  },
  showKeyboardShortcuts: {
    id: 'showKeyboardShortcuts',
    category: 'general',
    scope: 'global',
    binding: { key: '/', mod: true },
    alternate: { key: '?' },
  },
  toggleWeldAgent: {
    id: 'toggleWeldAgent',
    category: 'general',
    scope: 'global',
    binding: { key: 'j', mod: true },
  },
  closeDialogPanel: {
    id: 'closeDialogPanel',
    category: 'general',
    scope: 'global',
    binding: { key: 'Escape' },
  },
  sendOrSubmit: {
    id: 'sendOrSubmit',
    category: 'writing',
    scope: 'contextual',
    binding: { key: 'Enter', mod: true },
  },
};

export const HOTKEY_CATEGORIES: readonly HotkeyCategory[] = ['general', 'writing'];

interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Whether a key event is exactly this binding (extra modifiers do not match). */
export function matchesBinding(event: KeyEventLike, binding: HotkeyBinding): boolean {
  const hasMod = event.metaKey || event.ctrlKey;
  if (hasMod !== Boolean(binding.mod)) return false;
  if (event.altKey !== Boolean(binding.alt)) return false;
  if (binding.shift !== undefined && event.shiftKey !== binding.shift) return false;
  return event.key.toLowerCase() === binding.key.toLowerCase();
}

/** Whether a key event triggers the hotkey, through its main or alternate binding. */
export function matchesHotkey(event: KeyEventLike, hotkey: HotkeyDefinition): boolean {
  return matchesBinding(event, hotkey.binding) || (hotkey.alternate ? matchesBinding(event, hotkey.alternate) : false);
}

const KEY_LABELS: Record<string, string> = {
  escape: 'Esc',
  enter: 'Enter',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
};

/**
 * Display tokens for a binding, modifiers first, in the neutral form the
 * shortcut formatter takes (`['mod', 'K']`).
 */
export function bindingKeys(binding: HotkeyBinding): string[] {
  const keys: string[] = [];
  if (binding.mod) keys.push('mod');
  if (binding.alt) keys.push('alt');
  if (binding.shift) keys.push('shift');
  const label = KEY_LABELS[binding.key.toLowerCase()];
  keys.push(label ?? (binding.key.length === 1 ? binding.key.toUpperCase() : binding.key));
  return keys;
}

/** Whether a key event came from somewhere the user is typing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}
