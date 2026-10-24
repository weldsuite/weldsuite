/**
 * A forgiving HTML parser, enough for what lands on the clipboard and in
 * .html files: tags, attributes, entities, comments, raw-text elements and
 * the usual implied end tags. It builds a plain tree (no DOM, so it runs in
 * workers too) and never throws on bad markup.
 *
 * Word's clipboard wraps list markers in `<![if !supportLists]>` (or the
 * comment form `<!--[if !supportLists]-->`); that text is kept apart, on the
 * element that follows, as `listMarker`, so the reader can tell numbered
 * from bulleted lists without showing the marker twice.
 */

export interface HtmlElement {
  type: 'element';
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
  /** Word list marker text found just before this element's content. */
  listMarker?: string;
}

export interface HtmlText {
  type: 'text';
  text: string;
}

export type HtmlNode = HtmlElement | HtmlText;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'template', 'noscript']);

/** Tags that end an open `<p>` (and similar) when they start. */
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul', 'figure', 'li',
]);

const IMPLIED_END: Record<string, string[]> = {
  li: ['li'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  tr: ['tr', 'td', 'th'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  thead: ['tbody', 'tfoot', 'thead', 'tr', 'td', 'th'],
  tbody: ['tbody', 'tfoot', 'thead', 'tr', 'td', 'th'],
  tfoot: ['tbody', 'tfoot', 'thead', 'tr', 'td', 'th'],
  option: ['option'],
};

/** Elements an implied end may not cross (a `<li>` does not close the `<li>` of an outer list). */
const SCOPE = new Set(['ul', 'ol', 'table', 'td', 'th', 'blockquote', 'div']);

export function parseHtml(html: string): HtmlElement {
  const root: HtmlElement = { type: 'element', tag: '#root', attrs: {}, children: [] };
  const stack: HtmlElement[] = [root];
  const top = () => stack[stack.length - 1]!;
  let markerCapture: string | null = null;
  let i = 0;

  // The marker belongs to the paragraph it sits in (the innermost open element).
  const attachMarker = (marker: string) => {
    const host = top();
    if (host.tag !== '#root') host.listMarker = marker;
  };

  const addText = (text: string) => {
    if (!text) return;
    if (markerCapture !== null) {
      markerCapture += decodeEntities(text);
      return;
    }
    const parent = top();
    const last = parent.children[parent.children.length - 1];
    if (last?.type === 'text') last.text += decodeEntities(text);
    else parent.children.push({ type: 'text', text: decodeEntities(text) });
  };

  const closeTo = (tag: string): boolean => {
    for (let s = stack.length - 1; s > 0; s--) {
      if (stack[s]!.tag === tag) {
        stack.length = s;
        return true;
      }
      if (SCOPE.has(stack[s]!.tag) && tag !== stack[s]!.tag) {
        if (!['td', 'th', 'tr', 'tbody', 'thead', 'tfoot', 'li'].includes(tag)) continue;
        return false;
      }
    }
    return false;
  };

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      addText(html.slice(i));
      break;
    }
    addText(html.slice(i, lt));
    i = lt;

    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      const body = html.slice(i + 4, end < 0 ? html.length : end);
      i = end < 0 ? html.length : end + 3;
      if (/^\[if !supportLists\]/i.test(body)) markerCapture = '';
      else if (/^\[endif\]/i.test(body) && markerCapture !== null) {
        attachMarker(markerCapture.trim());
        markerCapture = null;
      }
      continue;
    }
    if (html.startsWith('<![', i)) {
      // Downlevel-revealed conditionals: <![if !supportLists]> … <![endif]>
      const end = html.indexOf('>', i);
      const body = html.slice(i + 3, end < 0 ? html.length : end);
      i = end < 0 ? html.length : end + 1;
      if (/^if !supportLists/i.test(body)) markerCapture = '';
      else if (/^endif/i.test(body) && markerCapture !== null) {
        attachMarker(markerCapture.trim());
        markerCapture = null;
      }
      continue;
    }
    if (html.startsWith('<!', i) || html.startsWith('<?', i)) {
      const end = html.indexOf('>', i);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    if (markerCapture !== null && /^<\/?[a-zA-Z]/.test(html.slice(i, i + 3))) {
      // Tags inside a list marker (Word wraps it in spans) are not content.
      const end = html.indexOf('>', i);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    if (html[i + 1] === '/') {
      const m = /^<\/\s*([a-zA-Z][\w:-]*)[^>]*>?/.exec(html.slice(i, i + 200));
      if (!m) {
        addText('<');
        i++;
        continue;
      }
      i += m[0].length;
      const tag = m[1]!.toLowerCase();
      if (tag === 'p' && !stack.some((e) => e.tag === 'p')) {
        // A stray </p> makes an empty paragraph, as browsers do.
        top().children.push({ type: 'element', tag: 'p', attrs: {}, children: [] });
      } else closeTo(tag);
      continue;
    }
    const tagMatch = /^<([a-zA-Z][\w:-]*)/.exec(html.slice(i, i + 100));
    if (!tagMatch) {
      addText('<');
      i++;
      continue;
    }
    const tag = tagMatch[1]!.toLowerCase();
    i += tagMatch[0].length;
    const { attrs, end, selfClosing } = readAttrs(html, i);
    i = end;

    if (RAW_TEXT.has(tag)) {
      const close = html.toLowerCase().indexOf(`</${tag}`, i);
      const text = html.slice(i, close < 0 ? html.length : close);
      i = close < 0 ? html.length : html.indexOf('>', close) + 1 || html.length;
      if (tag === 'textarea' || tag === 'xmp') addText(text);
      continue;
    }

    if (CLOSES_P.has(tag)) {
      let p = stack.length - 1;
      while (p > 0 && stack[p]!.tag !== 'p') p--;
      if (p > 0 && !stack.slice(p + 1).some((e) => SCOPE.has(e.tag))) stack.length = p;
    }
    const implied = IMPLIED_END[tag];
    if (implied) {
      for (let s = stack.length - 1; s > 0; s--) {
        const t = stack[s]!.tag;
        if (implied.includes(t)) {
          stack.length = s;
          break;
        }
        if (SCOPE.has(t) || (tag === 'li' && (t === 'ul' || t === 'ol'))) break;
      }
    }

    const el: HtmlElement = { type: 'element', tag, attrs, children: [] };
    top().children.push(el);
    if (!VOID.has(tag) && !selfClosing) stack.push(el);
  }
  return root;
}

function readAttrs(html: string, start: number): { attrs: Record<string, string>; end: number; selfClosing: boolean } {
  const attrs: Record<string, string> = {};
  let i = start;
  let selfClosing = false;
  while (i < html.length) {
    while (i < html.length && /\s/.test(html[i]!)) i++;
    const ch = html[i];
    if (ch === undefined) break;
    if (ch === '>') {
      i++;
      break;
    }
    if (ch === '/' && html[i + 1] === '>') {
      selfClosing = true;
      i += 2;
      break;
    }
    const nameMatch = /^[^\s=>/"']+/.exec(html.slice(i, i + 200));
    if (!nameMatch) {
      i++;
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    i += nameMatch[0].length;
    while (i < html.length && /\s/.test(html[i]!)) i++;
    let value = '';
    if (html[i] === '=') {
      i++;
      while (i < html.length && /\s/.test(html[i]!)) i++;
      const q = html[i];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, i + 1);
        value = html.slice(i + 1, close < 0 ? html.length : close);
        i = close < 0 ? html.length : close + 1;
      } else {
        const m = /^[^\s>]+/.exec(html.slice(i, i + 4096));
        value = m ? m[0] : '';
        i += value.length;
      }
    }
    if (!(name in attrs)) attrs[name] = decodeEntities(value);
  }
  return { attrs, end: i, selfClosing };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•',
  middot: '·', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', deg: '°', plusmn: '±',
  times: '×', divide: '÷', frac12: '½', frac14: '¼', frac34: '¾', laquo: '«', raquo: '»', shy: '­',
  ensp: ' ', emsp: ' ', thinsp: ' ', zwj: '‍', zwnj: '‌', larr: '←', rarr: '→',
  uarr: '↑', darr: '↓', check: '✓', iexcl: '¡', iquest: '¿', aacute: 'á', eacute: 'é', iacute: 'í',
  oacute: 'ó', uacute: 'ú', agrave: 'à', egrave: 'è', ograve: 'ò', auml: 'ä', euml: 'ë', iuml: 'ï',
  ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', ccedil: 'ç', ntilde: 'ñ',
};

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);?/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}
