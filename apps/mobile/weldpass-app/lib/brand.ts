/** WeldPass indigo, the colour of the platform's WeldPass icon (`#4f46e5`, dark `#818cf8`). */
export const BRAND = '#4F46E5';
export const BRAND_DARK = '#818CF8';

/** The brand colour that reads on the current theme's background. */
export function brandFor(theme: 'light' | 'dark'): string {
  return theme === 'dark' ? BRAND_DARK : BRAND;
}

/** Strength meter and health colours. */
export const STRENGTH_COLORS = {
  weak: '#DC2626',
  fair: '#D97706',
  strong: '#059669',
} as const;
