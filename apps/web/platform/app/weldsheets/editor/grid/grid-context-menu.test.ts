import { describe, expect, it } from 'vitest';
import { shortcutHint } from './grid-context-menu';

describe('shortcutHint', () => {
  it('uses Apple modifier order on Mac', () => {
    expect(shortcutHint('V', { shift: true }, true)).toBe('⇧⌘V');
    expect(shortcutHint('M', { alt: true }, true)).toBe('⌥⌘M');
    expect(shortcutHint('C', {}, true)).toBe('⌘C');
  });
  it('spells modifiers out elsewhere', () => {
    expect(shortcutHint('V', { shift: true }, false)).toBe('Ctrl+Shift+V');
    expect(shortcutHint('M', { alt: true }, false)).toBe('Ctrl+Alt+M');
  });
});
