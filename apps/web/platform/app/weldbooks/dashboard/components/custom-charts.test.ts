import { describe, expect, it } from 'vitest';
import { CHART_COLORS, parseDashboardCharts } from './custom-charts';

const stored = (color: unknown) => parseDashboardCharts([{ id: 'chart_1', source: 'revenue', type: 'bar', color }])[0].color;

describe('parseDashboardCharts colours', () => {
  it('keeps a theme colour as its variable', () => {
    expect(stored('var(--chart-4)')).toBe('var(--chart-4)');
  });

  it('keeps a colour of the user’s own as a lower-case hex code', () => {
    expect(stored('#A1B2C3')).toBe('#a1b2c3');
  });

  it('falls back to the dashboard’s colour for anything else', () => {
    expect(stored('#abc')).toBe(CHART_COLORS[0]);
    expect(stored('red')).toBe(CHART_COLORS[0]);
    expect(stored(42)).toBe(CHART_COLORS[0]);
  });
});
