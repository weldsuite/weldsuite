import type { WeldDesignTokens } from './protocol';

/**
 * Platform CSS variables (from `app/globals.css`) that WeldApps receive as
 * `--wui-*` tokens. The SDK allowlists the same names.
 */
const TOKEN_NAMES = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'border',
  'input',
  'ring',
  'radius',
] as const;

/**
 * Snapshot the live platform theme so apps render with the exact palette,
 * radius and font. Read after the theme class has been applied.
 */
export function readPlatformDesignTokens(): WeldDesignTokens {
  if (typeof document === 'undefined') return { vars: {} };
  const rootStyle = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const name of TOKEN_NAMES) {
    const value = rootStyle.getPropertyValue(`--${name}`).trim();
    if (value) vars[name] = value;
  }
  const fontFamily = getComputedStyle(document.body).fontFamily || undefined;
  const fontLink = document.querySelector<HTMLLinkElement>(
    'link[rel="stylesheet"][href^="https://fonts.googleapis.com/css"]',
  );
  return { vars, fontFamily, fontStylesheet: fontLink?.href };
}
