// ---------------------------------------------------------------------------
// Runtime migration: convert legacy BlockNote block JSON → HTML for the
// standalone paginated editor. Dependency-free (no BlockNote import) — it walks
// the serialized block shape and emits the simple HTML subset the new editor
// uses (<p>, <h1..3>, <ul>/<ol>/<li>, <blockquote>, <pre>, <hr>, inline marks +
// styled spans). Unknown blocks degrade to a paragraph of their text.
// ---------------------------------------------------------------------------

type Styles = Record<string, unknown>;

interface Block {
  type?: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: Block[];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

/** A BlockNote custom style value is either a string or `{ stringValue }`. */
function styleValue(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as { stringValue?: unknown }).stringValue === 'string') {
    return (v as { stringValue: string }).stringValue;
  }
  return undefined;
}

function applyStyles(text: string, styles?: Styles): string {
  let html = escapeHtml(text);
  if (!styles) return html;
  if (styles.code) html = `<code>${html}</code>`;
  if (styles.bold) html = `<strong>${html}</strong>`;
  if (styles.italic) html = `<em>${html}</em>`;
  if (styles.underline) html = `<u>${html}</u>`;
  if (styles.strike) html = `<s>${html}</s>`;

  const css: string[] = [];
  const tc = styleValue(styles.textColor);
  if (tc && tc !== 'default') css.push(`color:${tc}`);
  const bc = styleValue(styles.backgroundColor);
  if (bc && bc !== 'default') css.push(`background-color:${bc}`);
  const ff = styleValue(styles.fontFamily);
  if (ff) css.push(`font-family:${ff}`);
  const fs = styleValue(styles.fontSize);
  if (fs) css.push(`font-size:${fs}`);
  if (css.length) html = `<span style="${escapeAttr(css.join(';'))}">${html}</span>`;
  return html;
}

function inlineToHtml(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((node) => {
      if (!node || typeof node !== 'object') return '';
      const n = node as { type?: string; text?: string; styles?: Styles; href?: string; content?: unknown };
      if (n.type === 'link') {
        return `<a href="${escapeAttr(String(n.href ?? ''))}">${inlineToHtml(n.content)}</a>`;
      }
      if (typeof n.text === 'string') {
        return applyStyles(n.text, n.styles);
      }
      return '';
    })
    .join('');
}

function alignStyle(props?: Record<string, unknown>): string {
  const a = props?.textAlignment;
  return typeof a === 'string' && a !== 'left' ? ` style="text-align:${escapeAttr(a)}"` : '';
}

function blockToHtml(b: Block): string {
  const styleAttr = alignStyle(b.props);
  const inner = inlineToHtml(b.content);
  switch (b.type) {
    case 'heading': {
      const lvl = Math.min(3, Math.max(1, Number(b.props?.level) || 1));
      return `<h${lvl}${styleAttr}>${inner || '<br>'}</h${lvl}>`;
    }
    case 'quote':
      return `<blockquote${styleAttr}>${inner || '<br>'}</blockquote>`;
    case 'codeBlock':
      return `<pre><code>${inner}</code></pre>`;
    case 'divider':
      return '<hr>';
    case 'image': {
      const url = b.props?.url;
      return typeof url === 'string' && url ? `<p><img src="${escapeAttr(url)}" alt=""></p>` : '';
    }
    case 'paragraph':
    default:
      return `<p${styleAttr}>${inner || '<br>'}</p>`;
  }
}

function isListItem(type?: string): boolean {
  return type === 'bulletListItem' || type === 'numberedListItem' || type === 'checkListItem';
}

function listTagFor(type?: string): 'ol' | 'ul' {
  return type === 'numberedListItem' ? 'ol' : 'ul';
}

export function blockNoteToHtml(blocks: Block[]): string {
  if (!Array.isArray(blocks)) return '';
  const out: string[] = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    if (isListItem(block?.type)) {
      const tag = listTagFor(block.type);
      const items: string[] = [];
      // Group consecutive list items of the same kind (ordered vs unordered).
      while (i < blocks.length && isListItem(blocks[i]?.type) && listTagFor(blocks[i].type) === tag) {
        const item = blocks[i];
        let inner = inlineToHtml(item.content);
        if (Array.isArray(item.children) && item.children.length) {
          inner += blockNoteToHtml(item.children);
        }
        items.push(`<li>${inner || '<br>'}</li>`);
        i++;
      }
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }
    out.push(blockToHtml(block));
    i++;
  }
  return out.join('');
}
