/**
 * Glue for the React Email preview server (`pnpm --filter @weldsuite/emails dev`).
 * `scripts/generate-previews.ts` writes one file per template × preview ×
 * locale under `emails/`, each exporting `previewEmail(...)`.
 */

import type { EmailTemplate } from './define';
import type { EmailLocale } from './i18n';
import { templates, type TemplateId } from './templates';

export function previewEmail(id: TemplateId, preview: string, locale: EmailLocale) {
  const template = templates[id] as unknown as EmailTemplate<Record<string, unknown>>;
  const sample = template.previews[preview];
  if (!sample) throw new Error(`No preview "${preview}" for template "${id}"`);
  const { Component } = template;
  const brand = sample.brand ?? template.defaultBrand;
  return function Preview() {
    return <Component {...sample.props} locale={locale} brand={brand} />;
  };
}
