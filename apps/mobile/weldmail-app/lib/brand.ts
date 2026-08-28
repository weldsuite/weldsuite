/**
 * WeldMail brand tokens.
 *
 * `@weldsuite/mobile-ui`'s theme is deliberately neutral (black/white primary)
 * so each app layers its own accent on top. WeldMail is coral — the same
 * #F06543 the app icon and notification accent use.
 */

export const BRAND = '#F06543';
export const BRAND_DARK = '#D94E2F';
/** ~12% coral, for icon tiles and selected chips. */
export const BRAND_TINT = 'rgba(240,101,67,0.12)';

/**
 * Accent per mail action / surface area.
 */
export const ACCENTS = {
  unread: '#3B82F6',
  star: '#F59E0B',
  archive: '#3B82F6',
  snooze: '#F59E0B',
  delete: '#EF4444',
  pin: '#8B5CF6',
  labels: '#06B6D4',
  settings: '#6B7280',
  compose: '#F06543',
} as const;

/** ~12% tint of an accent, for rounded icon tiles and selected rows. */
export function tint(hex: string): string {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},0.12)`;
}
