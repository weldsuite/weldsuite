// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { presetSettings, THEME_PRESETS } from './defaults';
import { contrastRatio, readableOn, themeCssVariables, usedFontIds } from './theme-css';

describe('theme CSS', () => {
  it('keeps every preset readable at AA', () => {
    for (const preset of THEME_PRESETS) {
      const vars = themeCssVariables(presetSettings(preset.id));
      expect(contrastRatio(vars['--shop-foreground']!, vars['--shop-background']!), preset.id).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(vars['--shop-primary-foreground']!, vars['--shop-primary']!), preset.id).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('replaces text colours that do not read on their background', () => {
    expect(readableOn('#777777', '#ffffff')).toBe('#000000');
    expect(readableOn('#333333', '#000000')).toBe('#ffffff');
    expect(readableOn('#111111', '#ffffff')).toBe('#111111');
  });

  it('falls back to the preset for colours that are not #rrggbb, and maps radius and fonts', () => {
    const settings = presetSettings('warm');
    const vars = themeCssVariables({ ...settings, colors: { ...settings.colors, background: 'red; x: y' }, radius: 'large' });
    expect(vars['--shop-background']).toBe('#ffffff');
    expect(vars['--shop-radius']).toBe('1rem');
    expect(vars['--shop-font-heading']).toContain('Fraunces Variable');
  });

  it('lists the fonts to load', () => {
    expect(usedFontIds({ fontHeading: 'fraunces', fontBody: 'dm-sans' })).toEqual(['fraunces', 'dm-sans']);
    expect(usedFontIds({ fontHeading: 'system', fontBody: 'unknown' })).toEqual([]);
  });
});
