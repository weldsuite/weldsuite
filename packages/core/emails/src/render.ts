import { createElement, type ReactElement } from 'react';
import { convert, type FormatCallback } from 'html-to-text';
import type { EmailBrand } from './brand';
import type { EmailTemplate } from './define';
import type { EmailLocale } from './i18n';
import { templates, type TemplateId, type TemplateProps } from './templates';

export interface RenderOptions {
  /** Recipient's language; see `resolveEmailLocale`. Defaults to English. */
  locale?: EmailLocale;
  /** Defaults to the template's own brand. */
  brand?: EmailBrand;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const DOCTYPE =
  '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">';

/**
 * Render a React element to an HTML document.
 *
 * Done here rather than with `@react-email/render`, whose edge build statically
 * imports prettier (~1 MB) for its optional pretty-printing: that would land in
 * every worker that sends mail. `react-dom/server.edge` runs in Workers, Node
 * and Next.js alike; it is imported lazily so Next.js does not flag a
 * react-dom/server import in server code.
 */
export async function renderHtml(element: ReactElement): Promise<string> {
  const { renderToReadableStream } = await import('react-dom/server.edge');
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  const html = (await new Response(stream).text())
    // React 19 writes an HTML5 doctype; email clients get the XHTML one.
    .replace(/^<!DOCTYPE html>/i, '')
    // Image preload hints React 19 adds to <head>: meaningless in a mail client.
    .replace(/<link rel="preload" as="image"[^>]*\/?>/g, '')
    // Suspense boundary markers (<!--$-->), which some clients show.
    .replace(/<!--\/?\$-->/g, '');
  return `${DOCTYPE}${html}`;
}

/** Writes an element's content inline, followed by `suffix`. */
function inlineWithSuffix(suffix: string): FormatCallback {
  return (elem, walk, builder) => {
    walk(elem.children, builder);
    builder.addInline(suffix);
  };
}

/** The plain-text alternative of an HTML email. */
export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    formatters: {
      detailLabel: inlineWithSuffix(': '),
      detailPrevious: inlineWithSuffix(' → '),
      inline: inlineWithSuffix(''),
    },
    selectors: [
      // <Details> rows read "When: …" instead of label and value on separate lines.
      { selector: 'td[data-text=label]', format: 'detailLabel' },
      { selector: 'td[data-text=value]', format: 'inline' },
      { selector: 'span[data-text=previous]', format: 'detailPrevious' },
      { selector: 'img', format: 'skip' },
      // The hidden inbox preview line of <Preview>.
      { selector: '[data-skip-in-text=true]', format: 'skip' },
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true, linkBrackets: false } },
      { selector: 'h1', options: { uppercase: false } },
      { selector: 'table', format: 'block' },
      { selector: 'tr', format: 'block' },
      { selector: 'td', format: 'block' },
    ],
  })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Render a registered template to subject, HTML and plain text. */
export async function renderEmail<Id extends TemplateId>(
  id: Id,
  props: TemplateProps<Id>,
  options: RenderOptions = {},
): Promise<RenderedEmail> {
  const template = templates[id] as unknown as EmailTemplate<TemplateProps<Id>>;
  return renderTemplate(template, props, options);
}

/** Same as `renderEmail`, for a template object (previews, tests). */
export async function renderTemplate<P>(
  template: EmailTemplate<P>,
  props: P,
  options: RenderOptions = {},
): Promise<RenderedEmail> {
  const env = { locale: options.locale ?? 'en', brand: options.brand ?? template.defaultBrand };
  const html = await renderHtml(createElement(template.Component, { ...props, ...env }));
  return {
    subject: template.subject(props, env).replace(/[\r\n]+/g, ' ').trim(),
    html,
    text: htmlToText(html),
  };
}
