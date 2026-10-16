/** Colour helpers of the designer: theme tokens, hex normalising and style merging. */
import { COLOR_TOKENS, type ColorToken, type TemplateColor, type TemplateTheme } from '@weldsuite/books-domain/invoice-template/schema';

const HEX6 = /^#[0-9a-fA-F]{6}$/;

export const isColorToken = (value: string | undefined): value is ColorToken =>
  value !== undefined && (COLOR_TOKENS as readonly string[]).includes(value);

/** `#rgb`, `rgb` or `#rrggbb` (any case) as lower-case `#rrggbb`; null when it is not a colour. */
export function normalizeHex(input: string): string | null {
  const raw = input.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`.toLowerCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw}`.toLowerCase();
  return null;
}

export const isHex6 = (value: string): boolean => HEX6.test(value);

/** The `#rrggbb` a colour value prints as, theme tokens resolved. */
export function resolveColor(value: TemplateColor | undefined, theme: Pick<TemplateTheme, 'accent' | 'text' | 'muted'>, fallback: TemplateColor = 'text'): string {
  const v = value ?? fallback;
  if (v === 'accent') return theme.accent;
  if (v === 'text') return theme.text;
  if (v === 'muted') return theme.muted;
  return v;
}

/**
 * Shallow-merges a patch into an optional style object. A key set to
 * `undefined` is dropped, and an object left empty becomes `undefined`, so the
 * stored template stays free of empty style objects.
 */
export function mergeStyle<T extends object>(current: T | undefined, patch: Partial<{ [K in keyof T]: T[K] | undefined }>): T | undefined {
  const next: Record<string, unknown> = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return Object.keys(next).length === 0 ? undefined : (next as T);
}
