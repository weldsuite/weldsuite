/**
 * Color palettes for WeldChat — Instagram-styled dark and light themes.
 *
 * Values mirror Instagram's native app palette:
 *  - Light: white surfaces, near-black text, #8e8e8e secondary, #dbdbdb borders.
 *  - Dark:  true-black surfaces, #fafafa text, #a8a8a8 secondary, #262626 borders.
 *  - Primary action blue #0095f6, notification red #ed4956 in both themes.
 *  - The signature purple→pink→orange gradient is exported as `instagramGradient`.
 */

const dark = {
  // Backgrounds
  bgPrimary: '#000000',
  bgSecondary: '#121212',
  bgTertiary: '#1a1a1a',
  bgAccent: '#262626',
  bgMuted: '#1c1c1c',
  // Search field: a step between bgSecondary and bgTertiary
  searchField: '#161616',

  // Text
  textPrimary: '#fafafa',
  textSecondary: '#a8a8a8',
  textMuted: '#737373',
  textLink: '#e0f1ff',

  // Brand (Instagram primary blue)
  brand: '#0095f6',
  brandHover: '#1877f2',

  // Status
  online: '#2bde73',
  idle: '#f0b232',
  dnd: '#ed4956',
  offline: '#737373',

  // Accents
  danger: '#ed4956',
  success: '#2bde73',
  warning: '#f0b232',

  // Borders
  border: '#262626',
  borderStrong: '#363636',

  // Input
  inputBg: '#1a1a1a',
  inputBorder: '#262626',

  // Unread badge (Instagram notification red)
  badgeBg: '#ed4956',
  badgeText: '#fff',

  // Channel active
  channelActive: '#262626',
  channelHover: '#1a1a1a',
} as const;

const light = {
  // Backgrounds
  bgPrimary: '#ffffff',
  bgSecondary: '#fafafa',
  bgTertiary: '#efefef',
  bgAccent: '#f5f5f5',
  bgMuted: '#fafafa',
  // Search field: a step between bgSecondary and bgTertiary
  searchField: '#f4f4f4',

  // Text
  textPrimary: '#000000',
  textSecondary: '#8e8e8e',
  textMuted: '#c7c7c7',
  textLink: '#00376b',

  // Brand (Instagram primary blue)
  brand: '#0095f6',
  brandHover: '#1877f2',

  // Status
  online: '#2bde73',
  idle: '#f0b232',
  dnd: '#ed4956',
  offline: '#c7c7c7',

  // Accents
  danger: '#ed4956',
  success: '#2bde73',
  warning: '#f0b232',

  // Borders
  border: '#dbdbdb',
  borderStrong: '#c7c7c7',

  // Input
  inputBg: '#fafafa',
  inputBorder: '#dbdbdb',

  // Unread badge (Instagram notification red)
  badgeBg: '#ed4956',
  badgeText: '#fff',

  // Channel active
  channelActive: '#efefef',
  channelHover: '#fafafa',
} as const;

/** Instagram's signature brand gradient (top-left → bottom-right). */
export const instagramGradient = [
  '#515BD4',
  '#8134AF',
  '#DD2A7B',
  '#F58529',
  '#FEDA77',
] as const;

export type ColorScheme = { readonly [K in keyof typeof dark]: string };
export const themes = { dark, light } as const;
export type ThemeMode = keyof typeof themes;

/** @deprecated Use useTheme() hook instead. Kept for root _layout.tsx initial render. */
export const Colors = dark;
