/**
 * Body helpers shared by the full-page compose and the floating compose panel.
 *
 * The compose editor is a contentEditable div, so its value is HTML. A mail
 * needs both a `text/plain` alternative (`body`) and the markup (`htmlBody`);
 * sending the markup as `body` leaves raw tags in the plain part and in the
 * stored preview.
 */

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER',
  'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TR', 'UL',
]);
const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'HEAD']);

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** Converts editor HTML to tag-free text, keeping line breaks and list items. */
export function htmlToPlainText(html: string): string {
  if (!html) return '';
  if (!html.includes('<') && !html.includes('&')) return html.trim();

  const doc = new DOMParser().parseFromString(html, 'text/html');
  let out = '';

  const endsLine = () => out === '' || out.endsWith('\n');
  const ensureLineBreak = () => {
    if (!endsLine()) out += '\n';
  };

  const walk = (node: Node): void => {
    if (node.nodeType === TEXT_NODE) {
      const text = (node.nodeValue ?? '').replace(/\s+/g, ' ');
      // Source indentation between blocks is not content.
      if (text.trim() === '' && endsLine()) return;
      out += endsLine() ? text.trimStart() : text;
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;

    const el = node as Element;
    if (SKIPPED_TAGS.has(el.tagName)) return;
    if (el.tagName === 'BR') {
      out += '\n';
      return;
    }

    const isBlock = BLOCK_TAGS.has(el.tagName);
    if (isBlock) ensureLineBreak();
    if (el.tagName === 'LI') out += '- ';
    el.childNodes.forEach(walk);
    if (isBlock) ensureLineBreak();
  };

  doc.body.childNodes.forEach(walk);

  return out
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Turns plain text (e.g. a draft that only has a text part) into editor HTML. */
export function plainTextToHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, '<br>');
}

export interface ComposeBodies {
  /** Tag-free text for the text/plain alternative. */
  body: string;
  /** Markup for the text/html alternative. */
  htmlBody: string;
}

/** Splits the editor's HTML into the `body` / `htmlBody` pair every mail API takes. */
export function buildComposeBodies(editorHtml: string): ComposeBodies {
  const html = editorHtml.trim();
  return {
    body: htmlToPlainText(html),
    htmlBody: html.includes('<') ? html : html.replace(/\n/g, '<br>'),
  };
}
