import { Colors } from '@weldsuite/mobile-ui/constants/theme';

/** App-facing alias for mobile-ui theme tokens (light/dark share the same keys). */
export type ThemeColors = (typeof Colors)['light'];
export type ThemeMode = 'light' | 'dark';
