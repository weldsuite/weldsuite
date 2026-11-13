import type { CSSProperties } from 'react';
import type { FormThemeTokens } from '@weldsuite/forms-engine';

const FONTS: Record<FormThemeTokens['font'], string> = {
  inter: '"Inter Variable", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  system: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", ui-serif, serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  rounded: 'ui-rounded, "SF Pro Rounded", "Nunito", "Varela Round", system-ui, sans-serif',
  grotesk: '"Space Grotesk", "Helvetica Neue", Arial, sans-serif',
};

const RADIUS: Record<FormThemeTokens['radius'], { box: string; input: string }> = {
  none: { box: '0px', input: '0px' },
  small: { box: '4px', input: '4px' },
  medium: { box: '8px', input: '8px' },
  large: { box: '16px', input: '14px' },
  full: { box: '999px', input: '22px' },
};

const FONT_SCALE: Record<FormThemeTokens['fontSize'], string> = { small: '0.9', medium: '1', large: '1.15' };

/** The default theme (the schema's defaults), for a renderer given none. */
export const DEFAULT_THEME: FormThemeTokens = {
  font: 'inter',
  colors: { background: '#ffffff', question: '#1f2937', answer: '#2563eb', button: '#2563eb', buttonText: '#ffffff' },
  background: { overlay: 0 },
  radius: 'medium',
  alignment: 'left',
  fontSize: 'medium',
};

/** A theme as the CSS variables `styles.css` reads, set on the `.wf-root` element. */
export function themeStyle(theme: FormThemeTokens): CSSProperties {
  const vars: Record<string, string> = {
    '--wf-bg': theme.colors.background,
    '--wf-question': theme.colors.question,
    '--wf-answer': theme.colors.answer,
    '--wf-button': theme.colors.button,
    '--wf-button-text': theme.colors.buttonText,
    '--wf-font': FONTS[theme.font],
    '--wf-radius': RADIUS[theme.radius].box,
    '--wf-radius-input': RADIUS[theme.radius].input,
    '--wf-scale': FONT_SCALE[theme.fontSize],
    '--wf-overlay': String(Math.min(100, Math.max(0, theme.background.overlay)) / 100),
  };
  if (theme.background.imageUrl) vars['--wf-bg-image'] = `url("${theme.background.imageUrl.replace(/["\\n]/g, '')}")`;
  return vars as CSSProperties;
}
