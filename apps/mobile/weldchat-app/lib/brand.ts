/**
 * WeldChat brand tokens.
 *
 * `@weldsuite/mobile-ui`'s theme is deliberately neutral (black/white primary)
 * so each app layers its own accent on top. WeldChat is green — the same
 * #00bb67 the platform sidebar mark and the app icon use.
 */

export const BRAND = '#00bb67';
export const BRAND_DARK = '#009a54';
/** ~12% green, for icon tiles and selected chips. */
export const BRAND_TINT = 'rgba(0,187,103,0.12)';

/**
 * Accent per chat surface / status.
 */
export const ACCENTS = {
  online: '#10B981',
  idle: '#F59E0B',
  dnd: '#EF4444',
  offline: '#8E8E93',
  mention: '#3B82F6',
  unread: '#EF4444',
  settings: '#6B7280',
  call: '#266DF0',
} as const;

/** ~12% tint of an accent, for rounded icon tiles and selected rows. */
export function tint(hex: string): string {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},0.12)`;
}
