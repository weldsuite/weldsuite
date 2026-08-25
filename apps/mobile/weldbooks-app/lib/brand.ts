/**
 * WeldBooks brand tokens.
 *
 * `@weldsuite/mobile-ui`'s theme is deliberately neutral (black/white primary)
 * so each app layers its own accent on top. WeldBooks is emerald — the same
 * #10B981 the platform sidebar mark and the app icon use.
 */

export const BRAND = '#10B981';
export const BRAND_DARK = '#059669';
/** ~10% emerald, for icon tiles and selected chips. */
export const BRAND_TINT = 'rgba(16,185,129,0.12)';

/**
 * Accent per module area, mirroring the platform's WeldBooks section colours so
 * the two surfaces read as the same product.
 */
export const ACCENTS = {
  banking: '#3B82F6',
  reconciliation: '#8B5CF6',
  vat: '#10B981',
  profitLoss: '#F59E0B',
  balanceSheet: '#EC4899',
  contacts: '#06B6D4',
  settings: '#6B7280',
  documents: '#0EA5E9',
} as const;

/** ~12% tint of an accent, for the rounded icon tiles on menu rows. */
export function tint(hex: string): string {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},0.12)`;
}
