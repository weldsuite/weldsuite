/** The section colour schemes (`colorScheme` setting) as classes. */
export type ColorScheme = 'default' | 'muted' | 'primary';

export const COLOR_SCHEMES = ['default', 'muted', 'primary'] as const;

export function schemeClass(scheme: ColorScheme): string {
  switch (scheme) {
    case 'muted':
      return 'scheme-muted bg-shop-muted text-shop-on-muted';
    case 'primary':
      return 'scheme-primary bg-shop-primary text-shop-on-primary';
    default:
      return 'bg-shop-bg text-shop-fg';
  }
}

/** Grid columns on wide screens for the `columns` setting (two on tablets, one on phones). */
export function columnsClass(columns: string): string {
  switch (columns) {
    case '2':
      return 'grid-cols-1 sm:grid-cols-2';
    case '3':
      return 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3';
    default:
      return 'grid-cols-2 lg:grid-cols-4';
  }
}

export const COLUMN_OPTIONS = ['2', '3', '4'] as const;
