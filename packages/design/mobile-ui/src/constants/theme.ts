import { Platform } from 'react-native';

const tintColorLight = '#000';
const tintColorDark = '#fff';

export const Colors = {
  light: {
    text: '#000',
    background: '#FFFFFF',
    card: '#FFFFFF',
    cardBackground: '#FFFFFF',
    secondaryBackground: '#FFFFFF',
    tint: tintColorLight,
    icon: '#666',
    tabIconDefault: '#999',
    tabIconSelected: tintColorLight,
    border: '#E5E5EA',
    divider: '#C6C6C8',
    muted: '#8E8E93',
    subtle: '#666',
    buttonBorder: '#E5E7EB',
    pressed: 'rgba(0, 0, 0, 0.05)',
    // Semantic tokens (added for the @weldsuite/mobile-ui primitive set).
    primary: '#000000',
    primaryForeground: '#FFFFFF',
    secondary: '#F2F2F7',
    secondaryForeground: '#000000',
    destructive: '#DC2626',
    destructiveForeground: '#FFFFFF',
    success: '#10B981',
    successForeground: '#FFFFFF',
    warning: '#F59E0B',
    warningForeground: '#FFFFFF',
    info: '#3B82F6',
    infoForeground: '#FFFFFF',
    accent: '#F2F2F7',
    accentForeground: '#000000',
    mutedForeground: '#6B7280',
    inputBackground: '#F2F2F7',
    placeholder: '#9CA3AF',
    ring: '#000000',
    overlay: 'rgba(0, 0, 0, 0.5)',
    skeleton: '#E5E5EA',
  },
  dark: {
    text: '#fff',
    background: '#000000',
    card: '#1C1C1E',
    cardBackground: '#1C1C1E',
    secondaryBackground: '#1C1C1E',
    tint: tintColorDark,
    icon: '#999',
    tabIconDefault: '#666',
    tabIconSelected: tintColorDark,
    border: '#38383A',
    divider: '#38383A',
    muted: '#8E8E93',
    subtle: '#999',
    buttonBorder: '#4B5563',
    pressed: 'rgba(255, 255, 255, 0.08)',
    // Semantic tokens (added for the @weldsuite/mobile-ui primitive set).
    primary: '#FFFFFF',
    primaryForeground: '#000000',
    secondary: '#1C1C1E',
    secondaryForeground: '#FFFFFF',
    destructive: '#EF4444',
    destructiveForeground: '#FFFFFF',
    success: '#10B981',
    successForeground: '#FFFFFF',
    warning: '#F59E0B',
    warningForeground: '#FFFFFF',
    info: '#3B82F6',
    infoForeground: '#FFFFFF',
    accent: '#1C1C1E',
    accentForeground: '#FFFFFF',
    mutedForeground: '#9CA3AF',
    inputBackground: '#1C1C1E',
    placeholder: '#6B7280',
    ring: '#FFFFFF',
    overlay: 'rgba(0, 0, 0, 0.6)',
    skeleton: '#2C2C2E',
  },
};

/** Border-radius scale used by the mobile-ui primitive set. */
export const Radii = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  full: 9999,
} as const;

/** Spacing scale (in px) used by the mobile-ui primitive set. */
export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export const Fonts = Platform.select({
  ios: {
    sans: 'system-ui',
    serif: 'ui-serif',
    rounded: 'ui-rounded',
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    rounded: "'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Meiryo, 'MS PGothic', sans-serif",
    mono: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  },
});
