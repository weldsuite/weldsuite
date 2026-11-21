import { describe, expect, it } from 'vitest';
import { formatShortcut } from './shortcuts';

describe('formatShortcut', () => {
  it('writes Apple order symbols on a Mac', () => {
    expect(formatShortcut('Mod+B', true)).toBe('⌘B');
    expect(formatShortcut('Mod+Shift+Z', true)).toBe('⇧⌘Z');
    expect(formatShortcut('Ctrl+Alt+Shift+Mod+M', true)).toBe('⌃⌥⇧⌘M');
  });

  it('writes words elsewhere', () => {
    expect(formatShortcut('Mod+B', false)).toBe('Ctrl+B');
    expect(formatShortcut('Mod+Shift+Z', false)).toBe('Ctrl+Shift+Z');
    expect(formatShortcut('Mod+\\', false)).toBe('Ctrl+\\');
  });
});
