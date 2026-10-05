import type { ReactElement } from 'react';
import type { EmailBrand } from './brand';
import type { EmailLocale } from './i18n';

/** What every template component receives besides its own props. */
export interface TemplateEnv {
  locale: EmailLocale;
  brand: EmailBrand;
}

export interface TemplatePreview<P> {
  props: P;
  /** Overrides the template's default brand in the preview. */
  brand?: EmailBrand;
}

export interface EmailTemplate<P> {
  /** Brand used when the sender passes none. */
  defaultBrand: EmailBrand;
  /** The subject line, in the recipient's locale. */
  subject: (props: P, env: TemplateEnv) => string;
  /** The email body. Renders an <EmailLayout> around its content. */
  Component: (props: P & TemplateEnv) => ReactElement;
  /**
   * Named sample props. They feed the preview server (`pnpm dev`) and the
   * snapshot tests, so cover every variant the template has.
   */
  previews: Record<string, TemplatePreview<P>>;
}

/** Identity helper that infers `P` for a template definition. */
export function defineTemplate<P>(template: EmailTemplate<P>): EmailTemplate<P> {
  return template;
}
