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

/**
 * The web app stores project colours as Tailwind classes from its colour
 * picker (`bg-blue-500`), not hex. These are the 500 shades it offers.
 */
const TAILWIND_500: Record<string, string> = {
  red: '#EF4444',
  pink: '#EC4899',
  purple: '#A855F7',
  indigo: '#6366F1',
  blue: '#3B82F6',
  cyan: '#06B6D4',
  teal: '#14B8A6',
  green: '#22C55E',
  yellow: '#EAB308',
  orange: '#F97316',
  amber: '#F59E0B',
  gray: '#6B7280',
};

/**
 * A stored project colour as `#rrggbb`: hex (`#abc`, `#aabbcc`, `#aabbccdd`)
 * or a Tailwind `bg-<name>-500` class. Anything else gets the brand coral.
 */
export function projectColor(value: string | null | undefined): string {
  const color = value?.trim() ?? '';
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color)?.[1];
  if (hex) {
    if (hex.length === 3) return `#${[...hex].map((c) => c + c).join('')}`.toUpperCase();
    return `#${hex.slice(0, 6)}`.toUpperCase();
  }
  const name = /^(?:bg-)?([a-z]+)-500$/.exec(color)?.[1];
  return (name && TAILWIND_500[name]) || BRAND;
}

/** ~12% tint of an accent, for the rounded icon tiles on menu rows. */
export function tint(hex: string): string {
  const value = hex.replace('#', '');
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},0.12)`;
}
