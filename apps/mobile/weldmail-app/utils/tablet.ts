import { useWindowDimensions } from 'react-native';

const TABLET_MIN_WIDTH = 768;

export function useIsTablet() {
  const { width } = useWindowDimensions();
  return width >= TABLET_MIN_WIDTH;
}

/**
 * Returns scaled values for tablet. On phone returns the base value,
 * on iPad multiplies by the scale factor (default 1.25).
 */
export function useTabletScale(scale = 1.25) {
  const isTablet = useIsTablet();
  return (value: number) => (isTablet ? Math.round(value * scale) : value);
}
