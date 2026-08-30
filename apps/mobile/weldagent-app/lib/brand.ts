/**
 * WeldAgent brand tokens.
 *
 * `@weldsuite/mobile-ui`'s theme is deliberately neutral (black/white primary)
 * so each app layers its own accent on top. WeldAgent is violet — the same
 * #8d65ef the platform sidebar mark and the app icon use.
 */

export const BRAND = '#8d65ef';
export const BRAND_DARK = '#6d4ed6';
export const BRAND_TINT = 'rgba(141,101,239,0.12)';

export const ACCENTS = {
  chat: '#8d65ef',
  agents: '#6366F1',
  activity: '#0EA5E9',
  credits: '#F59E0B',
  settings: '#6B7280',
} as const;

/** ~12% tint of an accent, for the rounded icon tiles on menu rows. */
export function tint(hex: string): string {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},0.12)`;
}
