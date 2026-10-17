import { describe, expect, it } from 'vitest';
import { isColorToken, mergeStyle, normalizeHex, resolveColor } from './colors';

const theme = { accent: '#3b61de', text: '#1a1a1f', muted: '#737885' };

describe('normalizeHex', () => {
  it('expands short hex and lower-cases', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc');
    expect(normalizeHex('FF8800')).toBe('#ff8800');
    expect(normalizeHex(' #0F766E ')).toBe('#0f766e');
  });

  it('rejects anything else', () => {
    expect(normalizeHex('red')).toBeNull();
    expect(normalizeHex('#12345')).toBeNull();
    expect(normalizeHex('')).toBeNull();
  });
});

describe('resolveColor', () => {
  it('resolves tokens and passes hex through', () => {
    expect(resolveColor('accent', theme)).toBe('#3b61de');
    expect(resolveColor('muted', theme)).toBe('#737885');
    expect(resolveColor('#ffffff', theme)).toBe('#ffffff');
    expect(resolveColor(undefined, theme, 'accent')).toBe('#3b61de');
  });

  it('knows the tokens', () => {
    expect(isColorToken('accent')).toBe(true);
    expect(isColorToken('#fff')).toBe(false);
    expect(isColorToken(undefined)).toBe(false);
  });
});

describe('mergeStyle', () => {
  it('merges and drops undefined keys', () => {
    expect(mergeStyle<{ bold?: boolean; italic?: boolean }>({ bold: true }, { italic: true })).toEqual({ bold: true, italic: true });
    expect(mergeStyle<{ bold?: boolean; italic?: boolean }>({ bold: true, italic: true }, { bold: undefined })).toEqual({ italic: true });
  });

  it('returns undefined when nothing is left', () => {
    expect(mergeStyle({ bold: true }, { bold: undefined })).toBeUndefined();
    expect(mergeStyle(undefined, {})).toBeUndefined();
  });
});
