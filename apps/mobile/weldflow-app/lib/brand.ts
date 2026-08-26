/**
 * WeldFlow brand tokens.
 *
 * `@weldsuite/mobile-ui`'s theme is deliberately neutral (black/white primary)
 * so each app layers its own accent on top. WeldFlow is coral — the same
 * #E84C3D the platform sidebar mark and the app icon use.
 */

export const BRAND = '#E84C3D';
export const BRAND_DARK = '#C73A2E';
/** ~12% coral, for icon tiles and selected chips. */
export const BRAND_TINT = 'rgba(232,76,61,0.12)';

/**
 * Accent per module area, mirroring the platform's WeldFlow section colours so
 * the two surfaces read as the same product.
 */
export const ACCENTS = {
  projects: '#E84C3D',
  tasks: '#3B82F6',
  myTasks: '#8B5CF6',
  overdue: '#DC2626',
  progress: '#10B981',
  settings: '#6B7280',
  privacy: '#0EA5E9',
  notifications: '#F59E0B',
} as const;

/** ~12% tint of an accent, for the rounded icon tiles on menu rows. */
export function tint(hex: string): string {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},0.12)`;
}
