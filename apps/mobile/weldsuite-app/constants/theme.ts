/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import { Platform } from 'react-native';

const tintColorLight = '#000';
const tintColorDark = '#fff';

export const Colors = {
  light: {
    text: '#000',
    background: '#FFFFFF',
    card: '#FFFFFF',                  // alias used across many screens
    cardBackground: '#FFFFFF',        // iOS secondarySystemGroupedBackground
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
    pressed: 'rgba(0, 0, 0, 0.05)',   // iOS highlight on press
  },
  dark: {
    text: '#fff',
    background: '#000000',
    card: '#1C1C1E',                  // alias used across many screens
    cardBackground: '#1C1C1E',        // iOS secondarySystemGroupedBackground
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
    pressed: 'rgba(255, 255, 255, 0.08)', // iOS highlight on press
  },
};

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
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
