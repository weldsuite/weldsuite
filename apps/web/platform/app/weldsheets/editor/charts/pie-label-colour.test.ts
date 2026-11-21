import { describe, expect, it } from 'vitest';
import { CHART_PALETTE } from '@weldsuite/sheets-engine';
import { readableOn } from './draw-chart';

describe('readableOn', () => {
  it('uses dark text on light slices and white on dark ones', () => {
    expect(readableOn('#f6c344')).not.toBe('#ffffff');
    expect(readableOn('#ffffff')).not.toBe('#ffffff');
    expect(readableOn('#1d4ed8')).toBe('#ffffff');
    expect(readableOn('#000000')).toBe('#ffffff');
  });
  it('answers for every palette colour', () => {
    for (const colour of CHART_PALETTE) expect(readableOn(colour)).toMatch(/^#[0-9a-f]{6}$/);
  });
});
