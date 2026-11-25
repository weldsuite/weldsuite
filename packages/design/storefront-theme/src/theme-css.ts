/**
 * Theme settings as CSS custom properties. The renderer puts them on `<html>`
 * (`style`), and `styles.css` maps them onto Tailwind's theme (`bg-shop-bg`,
 * `text-shop-fg`, `rounded-shop`, `font-heading`, …).
 *
 * Colours are merchant input, so the text colours are checked against their
 * background: below the WCAG AA ratio for normal text (4.5:1) the text
 * colour becomes black or white, whichever reads better.
 */

import { THEME_FONTS, presetSettings } from './defaults';
import type { Radius, ThemeColors, ThemeSettings } from './types';

const HEX = /^#([0-9a-f]{6})$/i;
export const AA_CONTRAST = 4.5;

const RADIUS: Record<Radius, string> = { none: '0px', small: '0.25rem', medium: '0.5rem', large: '1rem' };

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of `#rrggbb`; null for anything else. */
export function luminance(hex: string): number | null {
  const match = HEX.exec(hex.trim());
  if (!match) return null;
  const n = Number.parseInt(match[1] ?? '', 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** The WCAG contrast ratio of two `#rrggbb` colours; 1 when either is not one. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return 1;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** `text` when it reads on `background` at AA, else black or white. */
export function readableOn(text: string, background: string, minimum = AA_CONTRAST): string {
  if (luminance(text) !== null && contrastRatio(text, background) >= minimum) return text;
  return contrastRatio('#000000', background) >= contrastRatio('#ffffff', background) ? '#000000' : '#ffffff';
}

/** A colour of the settings, or the classic preset's when it is not `#rrggbb`. */
function color(colors: Partial<ThemeColors> | undefined, key: keyof ThemeColors): string {
  const value = colors?.[key];
  return typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : presetSettings('classic').colors[key];
}

/** The `font-family` stack of a theme font id; the system stack for an unknown one. */
export function fontFamily(id: string): string {
  return (THEME_FONTS.find((font) => font.id === id) ?? THEME_FONTS[THEME_FONTS.length - 1]!).family;
}

/** The font ids the settings use, for the renderer to load just those. */
export function usedFontIds(settings: Pick<ThemeSettings, 'fontHeading' | 'fontBody'>): string[] {
  const known = new Set(THEME_FONTS.map((font) => font.id));
  return [...new Set([settings.fontHeading, settings.fontBody])].filter((id) => known.has(id) && id !== 'system');
}

/** The custom properties for the settings (names without a value never appear). */
export function themeCssVariables(settings: ThemeSettings): Record<string, string> {
  const background = color(settings.colors, 'background');
  const foreground = readableOn(color(settings.colors, 'foreground'), background);
  const primary = color(settings.colors, 'primary');
  const primaryForeground = readableOn(color(settings.colors, 'primaryForeground'), primary);
  const muted = color(settings.colors, 'muted');
  const border = color(settings.colors, 'border');
  // Links and focus rings use the primary colour when it reads on the page, the text colour otherwise.
  const accent = contrastRatio(primary, background) >= AA_CONTRAST ? primary : foreground;
  return {
    '--shop-background': background,
    '--shop-foreground': foreground,
    '--shop-primary': primary,
    '--shop-primary-foreground': primaryForeground,
    '--shop-muted': muted,
    '--shop-muted-foreground': readableOn(foreground, muted),
    '--shop-border': border,
    '--shop-accent': accent,
    '--shop-radius': RADIUS[settings.radius] ?? RADIUS.small,
    '--shop-font-heading': fontFamily(settings.fontHeading),
    '--shop-font-body': fontFamily(settings.fontBody),
  };
}

/** The same properties as a `style` attribute value. */
export function themeStyle(settings: ThemeSettings): string {
  return Object.entries(themeCssVariables(settings))
    .map(([name, value]) => `${name}: ${value}`)
    .join('; ');
}
