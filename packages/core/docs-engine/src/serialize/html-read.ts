/**
 * HTML in: a paste from Word, Google Docs, a web page or an email, and the
 * .html import. Produces a fragment (content plus the list definitions it
 * needs) ready to insert.
 *
 * Formatting comes from tags and inline CSS. What equals the paragraph's
 * named style is dropped, so a paste from Google Docs (which spells out
 * Arial 11 pt black on every span) does not leave direct formatting behind.
 */

import { cleanStoryText, LINE_BREAK, TAB } from '../model/chars';
import { ContentBuilder, type Fragment, type TableCellInput } from '../model/builder';
import type { Content } from '../model/content';
import { BUILT_IN_STYLES, bulletList, checkList, numberedList } from '../model/defaults';
import { newId } from '../model/ids';
import type { CellProps, ObjectData } from '../model/objects';
import { resolveText } from '../model/resolve';
import type { ListDef, ListFormat, NamedStyle, ParaProps, TextStyle } from '../model/styles';
import { isEmptyObject, isSafeLink } from '../model/styles';
import { parseColor, parseFontFamily, parseLength, parseStyleAttr } from './css';
import { parseHtml, type HtmlElement, type HtmlNode } from './html-parse';

export interface HtmlReadOptions {
  /** Named styles of the target document (to drop formatting they already give); built-ins by default. */
  styles?: Record<string, NamedStyle> | Map<string, NamedStyle>;
  makeId?: () => string;
}

export function fromHtml(html: string, options: HtmlReadOptions = {}): Fragment {
  const reader = new HtmlReader(options);
  const content = reader.convert(parseHtml(html).children);
  return Object.keys(reader.lists).length ? { content, lists: reader.lists } : { content };
}

const BLOCK_TAGS = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre', 'section', 'article', 'header', 'footer',
  'main', 'nav', 'aside', 'address', 'figure', 'figcaption', 'dd', 'dt', 'dl', 'center', 'form', 'fieldset', 'details',
  'summary', 'caption', 'body', 'html',
]);
const SKIP_TAGS = new Set(['head', 'script', 'style', 'meta', 'link', 'title', 'template', 'noscript', 'button', 'select', 'svg', 'math', 'iframe', 'object']);

type Item =
  | { kind: 'text'; text: string; style: TextStyle }
  | { kind: 'break'; style: TextStyle }
  | { kind: 'tab'; style: TextStyle }
  | { kind: 'object'; data: ObjectData; style: TextStyle };

interface Ctx {
  text: TextStyle;
  para: ParaProps;
  pre: boolean;
  /** Inside a list: the list and level its items get. */
  list?: { id: string; level: number };
}

class HtmlReader {
  readonly lists: Record<string, ListDef> = {};
  readonly styles: Record<string, NamedStyle> | Map<string, NamedStyle>;
  readonly makeId: () => string;
  /** Word lists by their `lfo` id. */
  private readonly wordLists = new Map<string, string>();

  constructor(options: HtmlReadOptions) {
    this.styles = options.styles ?? BUILT_IN_STYLES;
    this.makeId = options.makeId ?? newId;
  }

  convert(nodes: HtmlNode[]): Content {
    const converter = new Converter(this);
    converter.nodes(nodes, { text: {}, para: {}, pre: false });
    return converter.finish();
  }

  hasStyle(id: string): boolean {
    return this.styles instanceof Map ? this.styles.has(id) : Object.hasOwn(this.styles, id);
  }

  newList(kind: 'bullet' | 'numbered' | 'check'): string {
    const id = this.makeId();
    this.lists[id] = kind === 'bullet' ? bulletList() : kind === 'numbered' ? numberedList() : checkList();
    return id;
  }

  /** Makes level `level` of list `id` use this numbering. */
  setLevel(id: string, level: number, format: ListFormat, start?: number): void {
    const l = this.lists[id]?.levels[level];
    if (!l) return;
    if (l.format !== format) {
      l.format = format;
      l.text = format === 'bullet' ? ['●', '○', '■'][level % 3]! : format === 'check' ? '☐' : `%${level + 1}.`;
    }
    if (start !== undefined) l.start = start;
  }

  wordList(lfo: string, level: number, marker: string): string {
    let id = this.wordLists.get(lfo);
    if (!id) {
      id = this.newList('bullet');
      this.wordLists.set(lfo, id);
    }
    const m = marker.replace(/\s+/g, '');
    if (/^\d+[.)]?$/.test(m)) this.setLevel(id, level, 'decimal');
    else if (/^[ivxlcdm]+[.)]$/.test(m)) this.setLevel(id, level, 'lowerRoman');
    else if (/^[IVXLCDM]+[.)]$/.test(m)) this.setLevel(id, level, 'upperRoman');
    else if (/^[a-z][.)]$/.test(m)) this.setLevel(id, level, 'lowerAlpha');
    else if (/^[A-Z][.)]$/.test(m)) this.setLevel(id, level, 'upperAlpha');
    else this.setLevel(id, level, 'bullet');
    return id;
  }
}

class Converter {
  private readonly builder: ContentBuilder;
  private items: Item[] = [];
  /** Properties the paragraph being collected gets. */
  private para: ParaProps = {};
  private sawBreak = false;

  constructor(private readonly reader: HtmlReader) {
    this.builder = new ContentBuilder(reader.makeId);
  }

  finish(): Content {
    this.flush(false);
    return this.builder.build();
  }

  nodes(nodes: HtmlNode[], ctx: Ctx): void {
    for (const n of nodes) {
      if (n.type === 'text') this.text(n.text, ctx);
      else this.element(n, ctx);
    }
  }

  private text(raw: string, ctx: Ctx): void {
    if (ctx.pre) {
      const lines = raw.replace(/\r\n?/g, '\n').split('\n');
      lines.forEach((line, i) => {
        if (i > 0) this.flush(true);
        this.pushText(line.replace(/\t/g, TAB), ctx.text);
      });
      return;
    }
    const text = raw.replace(/[\t\n\r\f ]+/g, ' ');
    if (text) this.pushText(text, ctx.text);
  }

  private pushText(text: string, style: TextStyle): void {
    const clean = cleanStoryText(text.replace(/\n/g, ' '));
    if (!clean) return;
    const last = this.items[this.items.length - 1];
    if (last?.kind === 'text' && last.style === style) last.text += clean;
    else this.items.push({ kind: 'text', text: clean, style });
  }

  private element(el: HtmlElement, parent: Ctx): void {
    const tag = el.tag;
    if (SKIP_TAGS.has(tag) || (tag.includes(':') && tag !== 'o:p')) return;
    const css = parseStyleAttr(el.attrs.style);
    if (css.get('display') === 'none' || css.get('mso-hide') === 'all') return;

    const ctx: Ctx = { ...parent, text: this.textStyle(tag, el, css, parent.text) };

    switch (tag) {
      case 'br':
        if (el.attrs['data-weld'] === 'pageBreak' || /always|page/.test(css.get('page-break-before') ?? css.get('break-before') ?? '')) {
          this.items.push({ kind: 'object', data: { kind: 'pageBreak' }, style: {} });
        } else {
          this.items.push({ kind: 'break', style: ctx.text });
          this.sawBreak = true;
        }
        return;
      case 'hr':
        this.flush(false);
        this.items.push({ kind: 'object', data: { kind: 'hr' }, style: {} });
        this.flush(false, {});
        return;
      case 'img':
        this.image(el, css, ctx);
        return;
      case 'table':
        this.table(el, ctx);
        return;
      case 'ul':
      case 'ol':
        this.list(el, ctx);
        return;
      case 'input':
        return;
    }

    if (el.attrs['data-weld-chip'] !== undefined) {
      this.items.push({ kind: 'object', data: { kind: 'chip', type: el.attrs['data-weld-chip'] || 'link', ref: el.attrs['data-ref'] ?? '', label: textOf(el) }, style: ctx.text });
      return;
    }
    if (el.attrs['data-weld-equation'] !== undefined) {
      this.items.push({ kind: 'object', data: { kind: 'equation', latex: el.attrs['data-weld-equation'] }, style: ctx.text });
      return;
    }

    if (!BLOCK_TAGS.has(tag)) {
      if (tag === 'sup' && el.children.some((c) => c.type === 'element' && c.tag === 'a' && /^#fn\d/.test(c.attrs.href ?? ''))) return;
      this.nodes(el.children, ctx);
      return;
    }

    // A block: what came before is its own paragraph; this one gets its own properties.
    this.flush(false);
    const outer = this.para;
    ctx.para = this.paraProps(tag, el, css, parent);
    if (tag === 'pre') ctx.pre = true;
    if (/pre/.test(css.get('white-space') ?? '')) ctx.pre = true;
    this.para = ctx.para;
    this.sawBreak = false;
    this.nodes(el.children, ctx);
    this.flush(this.sawBreak || isEmptyBlock(el));
    this.para = outer;
  }

  private paraProps(tag: string, el: HtmlElement, css: Map<string, string>, parent: Ctx): ParaProps {
    const props: ParaProps = {};
    const inherited = parent.para;
    // Named style: headings, our own marker, Google Docs' and Word's classes; blockquote and pre.
    const heading = /^h([1-6])$/.exec(tag);
    const weld = el.attrs['data-weld-style'];
    const cls = (el.attrs.class ?? '').toLowerCase();
    if (heading) props.style = `heading${heading[1]}`;
    else if (weld && this.reader.hasStyle(weld)) props.style = weld;
    else if (/\btitle\b|msotitle/.test(cls)) props.style = 'title';
    else if (/\bsubtitle\b|msosubtitle/.test(cls)) props.style = 'subtitle';
    else if (tag === 'pre') props.style = 'code';
    else if (tag === 'blockquote' || /msoquote/.test(cls)) props.style = 'quote';
    else if (inherited.style) props.style = inherited.style;

    const align = (css.get('text-align') ?? el.attrs.align ?? '').toLowerCase();
    if (align === 'center' || align === 'right' || align === 'justify') props.align = align;
    else if (align === 'left' || align === 'start') props.align = 'left';
    else if (inherited.align) props.align = inherited.align;
    if (tag === 'center') props.align = 'center';

    const list = parent.list;
    const mso = /l(\d+)\s+level(\d+)\s+lfo(\d+)/i.exec(css.get('mso-list') ?? '');
    if (mso) {
      const level = Math.min(8, Math.max(0, Number(mso[2]) - 1));
      props.list = { id: this.reader.wordList(mso[3]!, level, el.listMarker ?? ''), level };
    } else if (tag === 'li' && list) {
      props.list = { ...list };
      const checked = el.attrs['data-checked'] ?? el.attrs['aria-checked'];
      const box = el.children.find((c): c is HtmlElement => c.type === 'element' && c.tag === 'input' && c.attrs.type === 'checkbox');
      if (checked !== undefined || box) {
        this.reader.setLevel(list.id, list.level, 'check');
        props.checked = checked === 'true' || (box ? 'checked' in box.attrs : false);
      }
    } else if (inherited.list && tag !== 'li') {
      props.list = inherited.list;
      if (inherited.checked !== undefined) props.checked = inherited.checked;
    }

    if (!props.list) {
      const left = parseLength(css.get('margin-left') ?? css.get('padding-left'));
      if (left && left > 0) props.indentLeft = round(left + (inherited.indentLeft ?? 0));
      else if (inherited.indentLeft) props.indentLeft = inherited.indentLeft;
      if (tag === 'blockquote' && !left) props.indentLeft = (inherited.indentLeft ?? 0) + 36;
      const first = parseLength(css.get('text-indent'));
      if (first) props.indentFirst = round(first);
    }
    const right = parseLength(css.get('margin-right'));
    if (right && right > 0) props.indentRight = round(right);
    const before = parseLength(css.get('margin-top'));
    if (before && before > 0) props.spaceBefore = round(before);
    const after = parseLength(css.get('margin-bottom'));
    if (after && after > 0) props.spaceAfter = round(after);
    const lh = css.get('line-height');
    if (lh && lh !== 'normal') {
      if (/^[\d.]+$/.test(lh)) props.lineHeight = clamp(parseFloat(lh), 0.5, 5);
      else if (lh.endsWith('%')) props.lineHeight = clamp(parseFloat(lh) / 100, 0.5, 5);
      else {
        const exact = parseLength(lh);
        if (exact && exact > 0) props.lineHeightExact = round(exact);
      }
    }
    const shading = parseColor(css.get('background-color') ?? css.get('background'));
    if (shading && shading !== '#ffffff') props.shading = shading;
    if ((css.get('direction') ?? el.attrs.dir) === 'rtl') props.direction = 'rtl';
    if (/always|page/.test(css.get('page-break-before') ?? css.get('break-before') ?? '')) props.pageBreakBefore = true;
    return props;
  }

  private textStyle(tag: string, el: HtmlElement, css: Map<string, string>, parent: TextStyle): TextStyle {
    const s: TextStyle = { ...parent };
    switch (tag) {
      case 'b':
      case 'strong':
        s.bold = true;
        break;
      case 'i':
      case 'em':
      case 'cite':
      case 'var':
        s.italic = true;
        break;
      case 'u':
      case 'ins':
        s.underline = true;
        break;
      case 's':
      case 'strike':
      case 'del':
        s.strike = true;
        break;
      case 'sup':
        s.script = 'super';
        break;
      case 'sub':
        s.script = 'sub';
        break;
      case 'code':
      case 'kbd':
      case 'samp':
      case 'tt':
        s.font = 'Courier New';
        break;
      case 'mark':
        s.highlight = '#ffff00';
        break;
      case 'a': {
        const href = (el.attrs.href ?? '').trim();
        if (href && isSafeLink(href) && !/^#fn/.test(href)) s.link = href.slice(0, 4096);
        break;
      }
      case 'font': {
        const face = parseFontFamily(el.attrs.face);
        if (face) s.font = face;
        const color = parseColor(el.attrs.color);
        if (color) s.color = color;
        const size = Number(el.attrs.size);
        if (size >= 1 && size <= 7) s.size = [7.5, 10, 12, 13.5, 18, 24, 36][size - 1];
        break;
      }
    }
    const weight = css.get('font-weight');
    if (weight) s.bold = /bold|bolder|[6-9]00/.test(weight);
    const fontStyle = css.get('font-style');
    if (fontStyle) s.italic = /italic|oblique/.test(fontStyle);
    const deco = css.get('text-decoration-line') ?? css.get('text-decoration');
    if (deco) {
      if (/none/.test(deco)) {
        s.underline = false;
        s.strike = false;
      }
      if (/underline/.test(deco)) s.underline = true;
      if (/line-through/.test(deco)) s.strike = true;
    }
    const color = parseColor(css.get('color'));
    if (color) s.color = color;
    const bg = parseColor(css.get('background-color') ?? css.get('mso-highlight') ?? css.get('background'));
    if (bg && !BLOCK_TAGS.has(tag) && bg !== '#ffffff') s.highlight = bg;
    const font = parseFontFamily(css.get('font-family'));
    if (font) s.font = font;
    const size = parseLength(css.get('font-size'), parent.size ?? 11);
    if (size && size > 0) s.size = clamp(round(size * 2) / 2, 1, 400);
    const va = css.get('vertical-align');
    if (va === 'super' || va === 'sub') s.script = va;
    else if (va === 'baseline') delete s.script;
    if (css.get('font-variant') === 'small-caps') s.smallCaps = true;
    if (css.get('text-transform') === 'uppercase') s.allCaps = true;
    const spacing = parseLength(css.get('letter-spacing'));
    if (spacing) s.spacing = clamp(round(spacing), -100, 100);
    return s;
  }

  private image(el: HtmlElement, css: Map<string, string>, ctx: Ctx): void {
    const src = (el.attrs.src ?? '').trim();
    if (!src || /^javascript:/i.test(src)) return;
    const width = parseLength(css.get('width')) ?? parseLength(el.attrs.width) ?? 200;
    const height = parseLength(css.get('height')) ?? parseLength(el.attrs.height) ?? 150;
    const data: ObjectData = {
      kind: 'image',
      id: this.reader.makeId(),
      src,
      width: clamp(round(width), 1, 5000),
      height: clamp(round(height), 1, 5000),
    };
    if (el.attrs.alt) data.alt = el.attrs.alt.slice(0, 2000);
    this.items.push({ kind: 'object', data, style: ctx.text.link ? { link: ctx.text.link } : {} });
  }

  private list(el: HtmlElement, ctx: Ctx): void {
    this.flush(false);
    const kind = el.tag === 'ol' ? 'numbered' : el.attrs['data-weld-list'] === 'check' ? 'check' : 'bullet';
    let list: { id: string; level: number };
    if (ctx.list) {
      list = { id: ctx.list.id, level: Math.min(8, ctx.list.level + 1) };
    } else {
      list = { id: this.reader.newList(kind), level: 0 };
    }
    const typeAttr = el.attrs.type;
    const format: ListFormat =
      kind === 'check' ? 'check' : kind === 'bullet' ? 'bullet' : typeAttr === 'a' ? 'lowerAlpha' : typeAttr === 'A' ? 'upperAlpha' : typeAttr === 'i' ? 'lowerRoman' : typeAttr === 'I' ? 'upperRoman' : 'decimal';
    const start = el.attrs.start !== undefined && /^\d+$/.test(el.attrs.start) ? Number(el.attrs.start) : undefined;
    this.reader.setLevel(list.id, list.level, format, start);
    const { list: _outerList, ...para } = ctx.para;
    const inner: Ctx = { ...ctx, list, para };
    for (const child of el.children) {
      if (child.type === 'element' && child.tag !== 'li' && child.tag !== 'ul' && child.tag !== 'ol') {
        // Content directly in a list (bad markup): treat as an item.
        this.element({ ...child, tag: BLOCK_TAGS.has(child.tag) ? child.tag : 'li', children: BLOCK_TAGS.has(child.tag) ? child.children : [child] }, inner);
      } else if (child.type === 'element') {
        this.element(child, inner);
      }
    }
  }

  private table(el: HtmlElement, ctx: Ctx): void {
    this.flush(false);
    const rows: HtmlElement[] = [];
    const headerRows = new Set<HtmlElement>();
    const collect = (node: HtmlElement, inHead: boolean) => {
      for (const c of node.children) {
        if (c.type !== 'element') continue;
        if (c.tag === 'tr') {
          rows.push(c);
          if (inHead) headerRows.add(c);
        } else if (c.tag === 'thead' || c.tag === 'tbody' || c.tag === 'tfoot') collect(c, c.tag === 'thead');
      }
    };
    collect(el, false);
    if (!rows.length) return;

    // Place cells on a grid, as browsers do, so row/column spans line up.
    const grid: (TableCellInput | null)[][] = [];
    const taken: boolean[][] = [];
    let colCount = 0;
    const widths: (number | null)[] = [];
    rows.forEach((tr, r) => {
      grid[r] ??= [];
      taken[r] ??= [];
      let c = 0;
      for (const td of tr.children) {
        if (td.type !== 'element' || (td.tag !== 'td' && td.tag !== 'th')) continue;
        while (taken[r]![c]) c++;
        const colSpan = clamp(Number(td.attrs.colspan) || 1, 1, 100);
        const rowSpan = clamp(Number(td.attrs.rowspan) || 1, 1, 1000);
        const css = parseStyleAttr(td.attrs.style);
        const props: CellProps = {};
        if (colSpan > 1) props.colSpan = colSpan;
        if (rowSpan > 1) props.rowSpan = Math.min(rowSpan, rows.length - r);
        const bg = parseColor(css.get('background-color') ?? css.get('background') ?? td.attrs.bgcolor);
        if (bg) props.background = bg;
        const va = css.get('vertical-align') ?? td.attrs.valign;
        if (va === 'middle' || va === 'bottom' || va === 'top') props.vAlign = va;
        const pad = parseLength(css.get('padding'));
        if (pad !== null && pad >= 0) props.padding = round(pad);
        const width = parseLength(css.get('width') ?? td.attrs.width);
        if (width && colSpan === 1 && widths[c] == null) widths[c] = width;
        const converter = new Converter(this.reader);
        converter.nodes(td.children, { text: td.tag === 'th' ? { ...ctx.text, bold: true } : ctx.text, para: {}, pre: false });
        grid[r]![c] = { content: converter.finish(), props };
        for (let dr = 0; dr < (props.rowSpan ?? 1); dr++) {
          taken[r + dr] ??= [];
          for (let dc = 0; dc < colSpan; dc++) taken[r + dr]![c + dc] = true;
        }
        c += colSpan;
        colCount = Math.max(colCount, c);
      }
    });
    for (const col of el.children.filter((c): c is HtmlElement => c.type === 'element' && (c.tag === 'colgroup' || c.tag === 'col'))) {
      const cols = col.tag === 'col' ? [col] : col.children.filter((c): c is HtmlElement => c.type === 'element' && c.tag === 'col');
      cols.forEach((c, i) => {
        const w = parseLength(parseStyleAttr(c.attrs.style).get('width') ?? c.attrs.width);
        if (w) widths[i] = w;
      });
    }
    if (colCount === 0) return;
    const known = widths.slice(0, colCount).filter((w): w is number => !!w);
    const fallback = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 451 / colCount;
    const cellRows: TableCellInput[][] = grid.map((row) => Array.from({ length: colCount }, (_, c) => row[c] ?? { content: { text: '\n' } }));
    const headerCount = rows.findIndex((tr) => !headerRows.has(tr) && !tr.children.every((c) => c.type !== 'element' || c.tag === 'th'));
    this.builder.addTable(cellRows, {
      widths: Array.from({ length: colCount }, (_, i) => clamp(round(widths[i] ?? fallback), 10, 2000)),
      headerRows: headerCount < 0 ? 0 : Math.min(headerCount, rows.length - 1),
    });
    this.builder.endParagraph(this.para);
  }

  /**
   * Ends the paragraph collected so far. An all-blank paragraph is kept only
   * when `force` (the block had a line break or was explicitly empty), as an
   * empty paragraph; a trailing line break is dropped, as browsers show none.
   */
  private flush(force: boolean, props: ParaProps = this.para): void {
    const items = this.items;
    this.items = [];
    if (items[items.length - 1]?.kind === 'break') items.pop();
    trimItems(items);
    const blank = items.every((i) => i.kind === 'text' && !i.text.replace(/ /g, ' ').trim());
    if (blank) {
      if (force || items.length) this.builder.endParagraph(cleanProps(props));
      return;
    }
    let checked = props.checked;
    // Our own checklist export writes the box as text in front of the item.
    const first = items[0];
    if (props.list && first?.kind === 'text' && /^[☐☑]/.test(first.text)) {
      checked = first.text.startsWith('☑');
      first.text = first.text.replace(/^[☐☑] ?/, '');
      if (!first.text) items.shift();
    }
    const named = resolveText({ styles: this.reader.styles }, props, {});
    for (const item of items) {
      const style = withoutDefaults(item.style, named);
      if (item.kind === 'text') this.builder.addText(item.text.replace(/ /g, ' '), style);
      else if (item.kind === 'break') this.builder.addText(LINE_BREAK, style);
      else if (item.kind === 'tab') this.builder.addText(TAB, style);
      else this.builder.addObject(item.data, style);
    }
    this.builder.endParagraph(cleanProps(checked === undefined ? props : { ...props, checked }));
  }
}

/** Collapses spaces across items and trims the paragraph's ends. */
function trimItems(items: Item[]): void {
  let prevSpace = true;
  for (const item of items) {
    if (item.kind !== 'text') {
      prevSpace = item.kind === 'break';
      continue;
    }
    if (prevSpace) item.text = item.text.replace(/^ +/, '');
    prevSpace = item.text.endsWith(' ') || (item.text === '' && prevSpace);
  }
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind !== 'text') break;
    item.text = item.text.replace(/ +$/, '');
    if (item.text) break;
  }
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === 'text' && !item.text) items.splice(i, 1);
  }
}

function withoutDefaults(style: TextStyle, named: TextStyle): TextStyle {
  const out: Record<string, unknown> = {};
  const base = named as Record<string, unknown>;
  for (const [k, v] of Object.entries(style)) {
    if (v === undefined) continue;
    if (v === false && !base[k]) continue;
    if (base[k] === v) continue;
    out[k] = v;
  }
  return out as TextStyle;
}

function cleanProps(props: ParaProps): ParaProps {
  const out = { ...props };
  if (out.style === 'normal') delete out.style;
  for (const k of Object.keys(out) as (keyof ParaProps)[]) if (out[k] === undefined) delete out[k];
  return isEmptyObject(out) ? {} : out;
}

function isEmptyBlock(el: HtmlElement): boolean {
  return el.children.length === 0 && el.tag === 'p';
}

function textOf(el: HtmlElement): string {
  let out = '';
  for (const c of el.children) out += c.type === 'text' ? c.text : textOf(c);
  return cleanStoryText(out.replace(/\s+/g, ' ').trim()).slice(0, 1000);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
