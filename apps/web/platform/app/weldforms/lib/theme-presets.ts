/**
 * Starting points for a theme. A preset is a token set, not a stored theme:
 * picking one opens the editor with its values, and saving makes a workspace
 * theme out of them.
 */

import { formThemeTokensSchema, type FormThemeTokens } from '@weldsuite/forms-engine';

export const THEME_PRESET_IDS = ['classic', 'midnight', 'sunrise', 'forest', 'paper', 'playful'] as const;
export type ThemePresetId = (typeof THEME_PRESET_IDS)[number];

const make = (input: unknown): FormThemeTokens => formThemeTokensSchema.parse(input);

export const THEME_PRESETS: Record<ThemePresetId, FormThemeTokens> = {
  classic: make({}),
  midnight: make({
    font: 'inter',
    colors: { background: '#0f172a', question: '#f8fafc', answer: '#38bdf8', button: '#38bdf8', buttonText: '#0f172a' },
    radius: 'medium',
  }),
  sunrise: make({
    font: 'rounded',
    colors: { background: '#fff7ed', question: '#431407', answer: '#ea580c', button: '#ea580c', buttonText: '#ffffff' },
    radius: 'large',
  }),
  forest: make({
    font: 'serif',
    colors: { background: '#f0fdf4', question: '#14532d', answer: '#15803d', button: '#15803d', buttonText: '#ffffff' },
    radius: 'small',
    alignment: 'center',
  }),
  paper: make({
    font: 'mono',
    colors: { background: '#fafaf9', question: '#1c1917', answer: '#1c1917', button: '#1c1917', buttonText: '#fafaf9' },
    radius: 'none',
  }),
  playful: make({
    font: 'grotesk',
    colors: { background: '#fdf4ff', question: '#4a044e', answer: '#c026d3', button: '#c026d3', buttonText: '#ffffff' },
    radius: 'full',
    alignment: 'center',
    fontSize: 'large',
  }),
};

/** `#rgb` and `#rrggbb` (any case) to the engine's `#rrggbb`; null when it isn't a colour. */
export function normalizeHex(input: string): string | null {
  const value = input.trim();
  const short = /^#?([0-9a-fA-F]{3})$/.exec(value);
  if (short) {
    const [r, g, b] = short[1]!.split('');
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  const long = /^#?([0-9a-fA-F]{6})$/.exec(value);
  return long ? `#${long[1]!.toLowerCase()}` : null;
}
