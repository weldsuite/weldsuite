import { BRAND, projectColor, tint } from '@/lib/brand';

describe('projectColor', () => {
  it('maps the web colour picker classes to their hex value', () => {
    expect(projectColor('bg-blue-500')).toBe('#3B82F6');
    expect(projectColor('bg-gray-500')).toBe('#6B7280');
  });

  it('normalises hex colours to #RRGGBB', () => {
    expect(projectColor('#e84c3d')).toBe('#E84C3D');
    expect(projectColor('#abc')).toBe('#AABBCC');
    expect(projectColor('#11223344')).toBe('#112233');
  });

  it('falls back to the brand colour for anything else', () => {
    expect(projectColor(null)).toBe(BRAND);
    expect(projectColor('')).toBe(BRAND);
    expect(projectColor('bg-magenta-500')).toBe(BRAND);
    expect(projectColor('rebeccapurple')).toBe(BRAND);
  });

  it('always yields a colour the tint helper can read', () => {
    expect(tint(projectColor('bg-red-500'))).toBe('rgba(239,68,68,0.12)');
    expect(tint(projectColor('nonsense'))).toBe(tint(BRAND));
  });
});
