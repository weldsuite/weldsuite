/**
 * Built-in starting points of the designer, one design per file in `./presets/`. "Classic" mirrors the
 * fixed layout invoices had before templates existed.
 */
import type { InvoiceTemplateDocument, PaperSize } from './schema';
import bold from './presets/bold';
import classic from './presets/classic';
import compact from './presets/compact';
import elegant from './presets/elegant';
import fresh from './presets/fresh';
import ledger from './presets/ledger';
import letterhead from './presets/letterhead';
import minimal from './presets/minimal';
import modern from './presets/modern';
import sidebar from './presets/sidebar';
import statement from './presets/statement';

export { DEFAULT_COLUMNS } from './preset-kit';

/** In the order the template picker shows them. */
export const TEMPLATE_PRESETS = ['classic', 'modern', 'minimal', 'bold', 'fresh', 'elegant', 'statement', 'sidebar', 'compact', 'letterhead', 'ledger'] as const;
export type TemplatePreset = (typeof TEMPLATE_PRESETS)[number];

/** A design for a paper size; `accent` is a #rrggbb brand colour, the design's own colour when absent. */
type PresetBuilder = (paperSize: PaperSize, accent?: string | null) => InvoiceTemplateDocument;

const PRESETS: Record<TemplatePreset, PresetBuilder> = { classic, modern, minimal, bold, fresh, elegant, statement, sidebar, compact, letterhead, ledger };

export function presetTemplate(preset: TemplatePreset, paperSize: PaperSize, accent?: string | null): InvoiceTemplateDocument {
  const color = accent && /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : undefined;
  return (PRESETS[preset] ?? PRESETS.classic)(paperSize, color);
}
