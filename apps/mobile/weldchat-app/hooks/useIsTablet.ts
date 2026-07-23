import { useWindowDimensions } from 'react-native';

const TABLET_MIN_WIDTH = 768;

export function useIsTablet(): boolean {
  const { width } = useWindowDimensions();
  return width >= TABLET_MIN_WIDTH;
}
