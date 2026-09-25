import { describe, expect, it } from 'vitest';
import { designTokenDeclarations, isAllowedFontStylesheet, isSafeCssValue } from './appearance';

describe('isSafeCssValue', () => {
  it('accepts colours, lengths and font stacks', () => {
    for (const value of [
      'oklch(0.205 0 0)',
      '#266df0',
      '0.625rem',
      'color-mix(in srgb, #0fc27b 16%, transparent)',
      "Inter, 'Inter Fallback', ui-sans-serif, system-ui, sans-serif",
    ]) {
      expect(isSafeCssValue(value)).toBe(true);
    }
  });

  it('rejects values that break out of a declaration or load resources', () => {
    for (const value of [
      'red; background: url(https://evil.test)',
      'url(https://evil.test/x.png)',
      '}body{display:none',
      '@import "x"',
      '</style><script>',
      'red\\3b',
      '',
      'x'.repeat(201),
      42,
    ]) {
      expect(isSafeCssValue(value)).toBe(false);
    }
  });
});

describe('designTokenDeclarations', () => {
  it('maps allowlisted tokens to --wui-* and drops the rest', () => {
    expect(
      designTokenDeclarations({
        vars: { primary: '#266df0', radius: '0.625rem', 'sidebar-x': '#000', background: 'url(x)' },
        fontFamily: 'Inter, sans-serif',
      }),
    ).toEqual([
      ['--wui-primary', '#266df0'],
      ['--wui-radius', '0.625rem'],
      ['--wui-font', 'Inter, sans-serif'],
    ]);
  });

  it('tolerates missing payloads', () => {
    expect(designTokenDeclarations(undefined)).toEqual([]);
    expect(designTokenDeclarations({ vars: undefined as unknown as Record<string, string> })).toEqual([]);
  });
});

describe('isAllowedFontStylesheet', () => {
  it('only allows Google Fonts CSS', () => {
    expect(isAllowedFontStylesheet('https://fonts.googleapis.com/css2?family=Inter')).toBe(true);
    expect(isAllowedFontStylesheet('https://evil.test/css2?family=Inter')).toBe(false);
    expect(isAllowedFontStylesheet('http://fonts.googleapis.com/css2')).toBe(false);
    expect(isAllowedFontStylesheet('javascript:alert(1)')).toBe(false);
  });
});
