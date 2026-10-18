import { describe, it, expect } from 'vitest';
import { formatShortcut, isMacPlatform, shortcutKeyLabels } from '@weldsuite/ui/lib/shortcut';
import { HOTKEYS, bindingKeys, matchesHotkey, matchesBinding, isTypingTarget } from './registry';

describe('isMacPlatform', () => {
  it('detects Apple platforms', () => {
    expect(isMacPlatform({ platform: 'MacIntel' })).toBe(true);
    expect(isMacPlatform({ platform: 'iPhone' })).toBe(true);
    expect(isMacPlatform({ userAgentData: { platform: 'macOS' }, platform: '' })).toBe(true);
  });

  it('treats everything else as non-Apple', () => {
    expect(isMacPlatform({ platform: 'Win32' })).toBe(false);
    expect(isMacPlatform({ platform: 'Linux x86_64' })).toBe(false);
    expect(isMacPlatform({ userAgentData: { platform: 'Windows' }, platform: 'Win32' })).toBe(false);
    expect(isMacPlatform(null)).toBe(false);
  });
});

describe('formatShortcut', () => {
  it('uses Command on Apple platforms', () => {
    expect(formatShortcut(['mod', 'K'], true)).toBe('⌘K');
    expect(formatShortcut(['mod', ','], true)).toBe('⌘,');
    expect(formatShortcut(['mod', 'shift', 'Z'], true)).toBe('⌘⇧Z');
    expect(formatShortcut(['mod', 'alt', 'I'], true)).toBe('⌘⌥I');
  });

  it('uses Ctrl elsewhere', () => {
    expect(formatShortcut(['mod', 'K'], false)).toBe('Ctrl+K');
    expect(formatShortcut(['mod', ','], false)).toBe('Ctrl+,');
    expect(formatShortcut(['mod', 'shift', 'Z'], false)).toBe('Ctrl+Shift+Z');
    expect(formatShortcut(['mod', 'alt', 'I'], false)).toBe('Ctrl+Alt+I');
  });

  it('leaves plain keys alone', () => {
    expect(formatShortcut(['Esc'], true)).toBe('Esc');
    expect(formatShortcut(['Esc'], false)).toBe('Esc');
    expect(formatShortcut(['?'], false)).toBe('?');
  });

  it('returns one label per key for rendering', () => {
    expect(shortcutKeyLabels(['mod', 'K'], false)).toEqual(['Ctrl', 'K']);
    expect(shortcutKeyLabels(['mod', 'K'], true)).toEqual(['⌘', 'K']);
  });
});

const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe('hotkey registry', () => {
  it('matches Cmd or Ctrl for mod bindings', () => {
    expect(matchesHotkey(key('k', { metaKey: true }), HOTKEYS.openCommandPalette)).toBe(true);
    expect(matchesHotkey(key('K', { ctrlKey: true }), HOTKEYS.openCommandPalette)).toBe(true);
    expect(matchesHotkey(key('k'), HOTKEYS.openCommandPalette)).toBe(false);
    expect(matchesHotkey(key('k', { ctrlKey: true, altKey: true }), HOTKEYS.openCommandPalette)).toBe(false);
  });

  it('matches the shortcuts help through Ctrl+/ and ?', () => {
    expect(matchesHotkey(key('/', { ctrlKey: true }), HOTKEYS.showKeyboardShortcuts)).toBe(true);
    expect(matchesHotkey(key('?', { shiftKey: true }), HOTKEYS.showKeyboardShortcuts)).toBe(true);
    expect(matchesHotkey(key('/'), HOTKEYS.showKeyboardShortcuts)).toBe(false);
    expect(matchesBinding(key('?', { ctrlKey: true }), { key: '?' })).toBe(false);
  });

  it('describes bindings as neutral display keys', () => {
    expect(bindingKeys(HOTKEYS.openCommandPalette.binding)).toEqual(['mod', 'K']);
    expect(bindingKeys(HOTKEYS.openSettings.binding)).toEqual(['mod', ',']);
    expect(bindingKeys(HOTKEYS.closeDialogPanel.binding)).toEqual(['Esc']);
    expect(bindingKeys(HOTKEYS.sendOrSubmit.binding)).toEqual(['mod', 'Enter']);
  });

  it('does not claim browser-reserved combinations', () => {
    const reserved = ['n', 't', 'w', 'l', 'd', 'r', 'f', 'p', 's', '1', '2', '3', '4', '5'];
    const bindings = Object.values(HOTKEYS).flatMap((h) => [h.binding, ...(h.alternate ? [h.alternate] : [])]);
    for (const binding of bindings) {
      if (binding.mod) expect(reserved).not.toContain(binding.key.toLowerCase());
    }
  });
});

describe('isTypingTarget', () => {
  it('is true for form fields and editable content', () => {
    expect(isTypingTarget(document.createElement('input'))).toBe(true);
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true);
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    // jsdom does not implement isContentEditable, so check the attribute path too.
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(isTypingTarget(editable)).toBe(true);
  });

  it('is false for other elements and non-elements', () => {
    expect(isTypingTarget(document.createElement('button'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
