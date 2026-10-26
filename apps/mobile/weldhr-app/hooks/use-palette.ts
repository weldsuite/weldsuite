import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { PALETTES, type Palette } from '@/constants/brand';

/** The app's colours for the current light or dark mode. */
export function usePalette(): Palette {
  const { theme } = useTheme();
  return PALETTES[theme === 'dark' ? 'dark' : 'light'];
}
