/**
 * WeldDesk brand tokens.
 *
 * `@weldsuite/mobile-ui`'s theme is deliberately neutral so each app layers its
 * own accent. WeldDesk is blue — the same #1E8FF9 the platform sidebar mark and
 * the app icon use.
 */

export const BRAND = '#1E8FF9';
export const BRAND_DARK = '#0B6FD4';
/** ~10% blue, for icon tiles and selected chips. */
export const BRAND_TINT = 'rgba(30,143,249,0.12)';

export const ACCENTS = {
  inbox: '#1E8FF9',
  email: '#0F766E',
  chat: '#8B5CF6',
  help: '#F59E0B',
  settings: '#6B7280',
  open: '#3B82F6',
  closed: '#6B7280',
} as const;

/** ~12% tint of an accent, for the rounded icon tiles on menu rows. */
export function tint(hex: string): string {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},0.12)`;
}
