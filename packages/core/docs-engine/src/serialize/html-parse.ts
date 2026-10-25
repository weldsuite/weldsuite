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
  return new HtmlParser(html).parse();
}

/** One pass over the markup, keeping the stack of open elements. */
class HtmlParser {
  private readonly root: HtmlElement = { type: 'element', tag: '#root', attrs: {}, children: [] };
  private readonly stack: HtmlElement[] = [this.root];
  /** Text of a Word list marker being collected, or null outside one. */
  private markerCapture: string | null = null;
  private i = 0;

  constructor(private readonly html: string) {}

  parse(): HtmlElement {
    const { html } = this;
    while (this.i < html.length) {
      const lt = html.indexOf('<', this.i);
      if (lt < 0) {
        this.addText(html.slice(this.i));
        break;
      }
      this.addText(html.slice(this.i, lt));
      this.i = lt;
      this.markup();
    }
    return this.root;
  }

  /** Reads whatever starts with the '<' at `i`. */
  private markup(): void {
    const { html, i } = this;
    if (html.startsWith('<!--', i)) this.comment();
    else if (html.startsWith('<![', i)) this.downlevelConditional();
    else if (html.startsWith('<!', i) || html.startsWith('<?', i)) this.skipPast('>');
    // Tags inside a list marker (Word wraps it in spans) are not content.
    else if (this.markerCapture !== null && /^<\/?[a-zA-Z]/.test(html.slice(i, i + 3))) this.skipPast('>');
    else if (html[i + 1] === '/') this.endTag();
    else this.startTag();
  }

  private top(): HtmlElement {
    return this.stack[this.stack.length - 1]!;
  }

  /** Moves past the next `token`, or to the end when there is none. */
  private skipPast(token: string): void {
    const end = this.html.indexOf(token, this.i);
    this.i = end < 0 ? this.html.length : end + token.length;
  }

  private comment(): void {
    const end = this.html.indexOf('-->', this.i + 4);
    const body = this.html.slice(this.i + 4, end < 0 ? this.html.length : end);
    this.i = end < 0 ? this.html.length : end + 3;
    this.listMarkerDirective(body, /^\[if !supportLists\]/i, /^\[endif\]/i);
  }

  /** Downlevel-revealed conditionals: <![if !supportLists]> … <![endif]> */
  private downlevelConditional(): void {
    const end = this.html.indexOf('>', this.i);
    const body = this.html.slice(this.i + 3, end < 0 ? this.html.length : end);
    this.i = end < 0 ? this.html.length : end + 1;
    this.listMarkerDirective(body, /^if !supportLists/i, /^endif/i);
  }

  /** Starts collecting a Word list marker, or ends it and hands it to its paragraph. */
  private listMarkerDirective(body: string, start: RegExp, end: RegExp): void {
    if (start.test(body)) this.markerCapture = '';
    else if (end.test(body) && this.markerCapture !== null) {
      this.attachMarker(this.markerCapture.trim());
      this.markerCapture = null;
    }
  }

  /** The marker belongs to the paragraph it sits in (the innermost open element). */
  private attachMarker(marker: string): void {
    const host = this.top();
    if (host.tag !== '#root') host.listMarker = marker;
  }

  private addText(text: string): void {
    if (!text) return;
    if (this.markerCapture !== null) {
      this.markerCapture += decodeEntities(text);
      return;
    }
    const parent = this.top();
    const last = parent.children[parent.children.length - 1];
    if (last?.type === 'text') last.text += decodeEntities(text);
    else parent.children.push({ type: 'text', text: decodeEntities(text) });
  }

  private endTag(): void {
    const m = /^<\/\s*([a-zA-Z][\w:-]*)[^>]*>?/.exec(this.html.slice(this.i, this.i + 200));
    if (!m) {
      this.addText('<');
      this.i++;
      return;
    }
    this.i += m[0].length;
    const tag = m[1]!.toLowerCase();
    if (tag === 'p' && !this.stack.some((e) => e.tag === 'p')) {
      // A stray </p> makes an empty paragraph, as browsers do.
      this.top().children.push({ type: 'element', tag: 'p', attrs: {}, children: [] });
    } else this.closeTo(tag);
  }

  /** Closes the innermost open `tag`; cell, row and item end tags do not reach past a scope element. */
  private closeTo(tag: string): void {
    const { stack } = this;
    for (let s = stack.length - 1; s > 0; s--) {
      const open = stack[s]!.tag;
      if (open === tag) {
        stack.length = s;
        return;
      }
      if (SCOPE.has(open) && CLOSED_WITHIN_SCOPE.has(tag)) return;
    }
  }

  private startTag(): void {
    const tagMatch = /^<([a-zA-Z][\w:-]*)/.exec(this.html.slice(this.i, this.i + 100));
    if (!tagMatch) {
      this.addText('<');
      this.i++;
      return;
    }
    const tag = tagMatch[1]!.toLowerCase();
    this.i += tagMatch[0].length;
    const { attrs, end, selfClosing } = readAttrs(this.html, this.i);
    this.i = end;

    if (RAW_TEXT.has(tag)) {
      this.rawText(tag);
      return;
    }
    if (CLOSES_P.has(tag)) this.closeOpenParagraph();
    const implied = IMPLIED_END[tag];
    if (implied) this.closeImplied(tag, implied);

    const el: HtmlElement = { type: 'element', tag, attrs, children: [] };
    this.top().children.push(el);
    if (!VOID.has(tag) && !selfClosing) this.stack.push(el);
  }

  /** The body of a raw-text element, up to its end tag; only textarea and xmp show it. */
  private rawText(tag: string): void {
    const { html } = this;
    const close = html.toLowerCase().indexOf(`</${tag}`, this.i);
    const text = html.slice(this.i, close < 0 ? html.length : close);
    this.i = close < 0 ? html.length : html.indexOf('>', close) + 1 || html.length;
    if (tag === 'textarea' || tag === 'xmp') this.addText(text);
  }

  /** Ends an open `<p>`, unless a scope element (a list, a table cell) lies between. */
  private closeOpenParagraph(): void {
    const { stack } = this;
    let p = stack.length - 1;
    while (p > 0 && stack[p]!.tag !== 'p') p--;
    if (p > 0 && !stack.slice(p + 1).some((e) => SCOPE.has(e.tag))) stack.length = p;
  }

  /** Ends the elements `tag` implies the end of (a `<li>` ends the previous `<li>`), within scope. */
  private closeImplied(tag: string, implied: string[]): void {
    const { stack } = this;
    for (let s = stack.length - 1; s > 0; s--) {
      const t = stack[s]!.tag;
      if (implied.includes(t)) {
        stack.length = s;
        return;
      }
      if (SCOPE.has(t) || (tag === 'li' && (t === 'ul' || t === 'ol'))) return;
    }
  }
}

/** End tags that stop at a scope element instead of closing past it. */
const CLOSED_WITHIN_SCOPE = new Set(['td', 'th', 'tr', 'tbody', 'thead', 'tfoot', 'li']);

function readAttrs(html: string, start: number): { attrs: Record<string, string>; end: number; selfClosing: boolean } {
  const attrs: Record<string, string> = {};
  let i = start;
  let selfClosing = false;
  while (i < html.length) {
    i = skipSpace(html, i);
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
    const attr = readAttrValue(html, skipSpace(html, i + nameMatch[0].length));
    i = attr.end;
    if (!(name in attrs)) attrs[name] = decodeEntities(attr.value);
  }
  return { attrs, end: i, selfClosing };
}

/** An attribute's `= value` part at `start` (quoted or bare); an empty value when there is none. */
function readAttrValue(html: string, start: number): { value: string; end: number } {
  if (html[start] !== '=') return { value: '', end: start };
  const i = skipSpace(html, start + 1);
  const q = html[i];
  if (q === '"' || q === "'") {
    const close = html.indexOf(q, i + 1);
    if (close < 0) return { value: html.slice(i + 1), end: html.length };
    return { value: html.slice(i + 1, close), end: close + 1 };
  }
  const m = /^[^\s>]+/.exec(html.slice(i, i + 4096));
  const value = m ? m[0] : '';
  return { value, end: i + value.length };
}

function skipSpace(html: string, start: number): number {
  let i = start;
  while (i < html.length && /\s/.test(html[i]!)) i++;
  return i;
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
