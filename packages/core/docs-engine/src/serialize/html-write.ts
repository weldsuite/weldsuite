/**
 * HTML out: the clipboard's text/html (so a copy pastes with its formatting
 * into Word, Google Docs or an email) and the .html export.
 *
 * Formatting is written as inline CSS, which is what other editors read;
 * headings use h1–h6, lists ul/ol, tables real tables. `data-weld-*`
 * attributes carry what CSS cannot say, so a paste back into WeldDocs keeps
 * named styles and checklists.
 */

import { HEADING_STYLES } from '../model/defaults';
import type { ObjectData, TableProps } from '../model/objects';
import { ListCounter, isOrdered } from '../model/numbering';
import type { BorderLine, ListLevel, ParaProps, TextStyle } from '../model/styles';
import { resolveText, styleChain, type StyleSource } from '../model/resolve';
import { lookup, toBlocks, type Block, type Inline, type ParagraphBlock, type TableBlock, type TableCellBlock, type WriteSource } from './blocks';

export interface HtmlOptions {
  /** URL for an image's `src` (e.g. a WeldDrive file id → a signed URL); default: as stored. */
  imageUrl?: (src: string) => string;
}

export function toHtml(source: WriteSource, options: HtmlOptions = {}): string {
  const writer = new HtmlWriter(source, options);
  const tree = toBlocks(source.content);
  let html = writer.blocks(tree.blocks);
  if (tree.footnotes.length) {
    html += '<hr><ol class="footnotes">';
    for (const fn of tree.footnotes) html += `<li id="fn${fn.number}">${writer.blocks(fn.blocks)}</li>`;
    html += '</ol>';
  }
  return html;
}

/** A standalone .html file. */
export function toHtmlDocument(source: WriteSource, title: string, options: HtmlOptions = {}): string {
  const normal = source.styles ? resolveText({ styles: source.styles }, {}, {}) : { font: 'Arial', size: 11 };
  return (
    '<!DOCTYPE html>\n<html><head><meta charset="utf-8">' +
    `<title>${escapeHtml(title)}</title>` +
    `<style>body{font-family:${cssFont(normal.font)};font-size:${normal.size}pt;max-width:46em;margin:2em auto;line-height:1.15}` +
    'p,h1,h2,h3,h4,h5,h6{margin:0}table{border-collapse:collapse}td{vertical-align:top}</style>' +
    `</head><body>${toHtml(source, options)}</body></html>`
  );
}

class HtmlWriter {
  private readonly counter: ListCounter;
  private readonly styles: StyleSource | null;
  private footnote = 0;

  constructor(
    private readonly source: WriteSource,
    private readonly options: HtmlOptions,
  ) {
    this.counter = new ListCounter(lookup(source.lists));
    this.styles = source.styles ? { styles: source.styles } : null;
  }

  blocks(blocks: Block[]): string {
    let out = '';
    // Open lists, outermost first.
    const open: OpenList[] = [];
    for (const b of blocks) {
      if (b.type === 'paragraph' && b.props.list) {
        out += this.listItem(b, b.props.list.level, open);
        continue;
      }
      out += closeLists(open, -1);
      out += b.type === 'paragraph' ? this.paragraph(b) : this.table(b);
    }
    return out + closeLists(open, -1);
  }

  /** Opens (or ends the previous) `<li>` for a list paragraph, opening and closing lists around it as the level changes. */
  private listItem(b: ParagraphBlock, level: number, open: OpenList[]): string {
    const list = this.counter.next(b.props);
    const tag = isOrdered(list?.level) ? 'ol' : 'ul';
    let out = closeLists(open, level);
    const top = open[open.length - 1];
    if (top && top.level === level && top.tag !== tag) {
      out += `</li></${open.pop()!.tag}>`;
    }
    if (!open.length || open[open.length - 1]!.level < level) out += openLists(open, tag, level, list?.level);
    else out += '</li>';
    const isCheck = list?.level.format === 'check';
    const checked = isCheck ? ` data-checked="${String(!!b.props.checked)}"` : '';
    const box = isCheck ? checkBox(b.props.checked) : '';
    return `${out}<li${checked}${styleAttr(this.paraCss(b.props, true))}>${box}${this.inlines(b)}`;
  }

  private paragraph(b: ParagraphBlock): string {
    const styleId = b.props.style ?? 'normal';
    const headingIndex = (HEADING_STYLES as readonly string[]).indexOf(styleId);
    const tag = headingIndex >= 0 ? `h${headingIndex + 1}` : 'p';
    const named = styleId !== 'normal' && headingIndex < 0 ? ` data-weld-style="${escapeAttr(styleId)}"` : '';
    const css = this.paraCss(b.props, false);
    const body = this.inlines(b);
    return `<${tag}${named}${styleAttr(css)}>${body || '<br>'}</${tag}>`;
  }

  private paraCss(props: ParaProps, inList: boolean): string {
    const css: string[] = this.namedStyleCss(props.style);
    if (props.align) css.push(`text-align:${props.align}`);
    if (!inList && props.indentLeft) css.push(`margin-left:${pt(props.indentLeft)}`);
    if (props.indentRight) css.push(`margin-right:${pt(props.indentRight)}`);
    if (!inList && props.indentFirst) css.push(`text-indent:${pt(props.indentFirst)}`);
    if (props.spaceBefore) css.push(`margin-top:${pt(props.spaceBefore)}`);
    if (props.spaceAfter) css.push(`margin-bottom:${pt(props.spaceAfter)}`);
    if (props.lineHeightExact) css.push(`line-height:${pt(props.lineHeightExact)}`);
    else if (props.lineHeight) css.push(`line-height:${props.lineHeight}`);
    if (props.shading) css.push(`background-color:${props.shading}`);
    if (props.direction === 'rtl') css.push('direction:rtl');
    if (props.pageBreakBefore) css.push('page-break-before:always');
    css.push(...paraBordersCss(props.borders));
    return css.join(';');
  }

  /** Text formatting of a named style other than normal, so other editors see it. */
  private namedStyleCss(style: string | undefined): string[] {
    if (!this.styles || !style || style === 'normal') return [];
    const chain = styleChain(this.styles, style).slice(1);
    let text: TextStyle = {};
    for (const s of chain) text = { ...text, ...s.text };
    return textCss(text);
  }

  private inlines(b: ParagraphBlock): string {
    let out = '';
    for (const inline of b.inlines) out += this.inline(inline);
    return out;
  }

  private inline(inline: Inline): string {
    switch (inline.type) {
      case 'text':
        return wrapText(escapeHtml(inline.text), inline.style);
      case 'break':
        return '<br>';
      case 'tab':
        return wrapText('<span style="white-space:pre">\t</span>', inline.style);
      case 'object':
        return this.object(inline.data, inline.style);
      case 'bookmark':
        return '';
    }
  }

  private object(d: ObjectData, style: TextStyle): string {
    switch (d.kind) {
      case 'image': {
        const src = this.options.imageUrl ? this.options.imageUrl(d.src) : d.src;
        return `<img src="${escapeAttr(src)}" alt="${escapeAttr(d.alt ?? '')}" width="${Math.round(d.width * 4 / 3)}" height="${Math.round(d.height * 4 / 3)}" style="width:${pt(d.width)};height:${pt(d.height)}">`;
      }
      case 'pageBreak':
        return '<br data-weld="pageBreak" style="page-break-before:always;clear:both">';
      case 'hr':
        return '<hr>';
      case 'footnote': {
        this.footnote++;
        return `<sup><a href="#fn${this.footnote}" id="fnref${this.footnote}">${this.footnote}</a></sup>`;
      }
      case 'chip':
        return wrapText(`<span data-weld-chip="${escapeAttr(d.type)}" data-ref="${escapeAttr(d.ref)}">${escapeHtml(d.label)}</span>`, style);
      case 'equation':
        return `<span data-weld-equation="${escapeAttr(d.latex)}">${escapeHtml(d.latex)}</span>`;
      default:
        return '';
    }
  }

  private table(t: TableBlock): string {
    const props = t.data.props ?? {};
    const tableCss = ['border-collapse:collapse'];
    if (props.align === 'center') tableCss.push('margin-left:auto', 'margin-right:auto');
    else if (props.align === 'right') tableCss.push('margin-left:auto');
    else if (props.indent) tableCss.push(`margin-left:${pt(props.indent)}`);
    let out = `<table style="${tableCss.join(';')}"><colgroup>`;
    for (const c of t.data.cols) out += `<col style="width:${pt(c.width)}">`;
    out += '</colgroup>';
    const headerRows = t.data.rows.filter((r, i) => r.header && t.data.rows.slice(0, i).every((x) => x.header)).length;
    t.rows.forEach((row, ri) => {
      if (ri === 0 && headerRows) out += '<thead>';
      if (ri === headerRows) out += '<tbody>';
      const height = t.data.rows[ri]?.height;
      out += height ? `<tr style="height:${pt(height)}">` : '<tr>';
      for (const cell of row) if (!cell.covered) out += this.cell(cell, props);
      out += '</tr>';
      if (ri === headerRows - 1) out += '</thead>';
    });
    if (headerRows < t.rows.length) out += '</tbody>';
    return out + '</table>';
  }

  /** A `<td>`: its borders fall back to the table's, its padding to the table's or 5 pt. */
  private cell(cell: TableCellBlock, table: TableProps): string {
    const css: string[] = [];
    const border = table.border ?? { width: 0.75, color: '#000000' };
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      css.push(`border-${side}:${borderCss(cell.props.borders?.[side] ?? border)}`);
    }
    css.push(`padding:${pt(cell.props.padding ?? table.padding ?? 5)}`);
    if (cell.props.background) css.push(`background-color:${cell.props.background}`);
    if (cell.props.vAlign) css.push(`vertical-align:${cell.props.vAlign}`);
    const span = spanAttr('colspan', cell.props.colSpan) + spanAttr('rowspan', cell.props.rowSpan);
    return `<td${span} style="${css.join(';')}">${this.blocks(cell.blocks)}</td>`;
  }
}

interface OpenList {
  tag: 'ul' | 'ol';
  level: number;
}

/** Closes the open lists deeper than `level`. */
function closeLists(open: OpenList[], level: number): string {
  let out = '';
  while (open.length && open[open.length - 1]!.level > level) out += `</li></${open.pop()!.tag}>`;
  return out;
}

/** Opens lists down to `level`; a level skipped on the way gets a bulletless item to hold the next one. */
function openLists(open: OpenList[], tag: 'ul' | 'ol', level: number, listLevel: ListLevel | undefined): string {
  let out = '';
  while (!open.length || open[open.length - 1]!.level < level) {
    const lvl = open.length ? open[open.length - 1]!.level + 1 : level;
    out += `<${tag}${listAttrs(tag, listLevel)}>`;
    open.push({ tag, level: lvl });
    if (lvl < level) out += '<li style="list-style:none">';
  }
  return out;
}

function listAttrs(tag: 'ul' | 'ol', level: ListLevel | undefined): string {
  const checklist = level?.format === 'check' ? ' data-weld-list="check" style="list-style:none"' : '';
  return checklist + (tag === 'ol' ? olAttrs(level) : '');
}

/** The box our own checklist export writes in front of an item (the HTML reader takes it back off). */
function checkBox(checked: boolean | undefined): string {
  return checked ? '☑ ' : '☐ ';
}

function styleAttr(css: string): string {
  return css ? ` style="${css}"` : '';
}

function spanAttr(name: string, span: number | undefined): string {
  return span && span > 1 ? ` ${name}="${span}"` : '';
}

function paraBordersCss(borders: ParaProps['borders']): string[] {
  const css: string[] = [];
  for (const side of ['top', 'bottom', 'left', 'right'] as const) {
    const line = borders?.[side];
    if (line) css.push(`border-${side}:${borderCss(line)}`);
  }
  return css;
}

/** `type` and `start` of an <ol>, so numbering formats survive a round trip. */
function olAttrs(level: ListLevel | undefined): string {
  if (!level) return '';
  const type = { lowerAlpha: 'a', upperAlpha: 'A', lowerRoman: 'i', upperRoman: 'I' }[level.format as string];
  return (type ? ` type="${type}"` : '') + (level.start !== undefined && level.start !== 1 ? ` start="${level.start}"` : '');
}

function wrapText(html: string, style: TextStyle): string {
  let out = html;
  const css = textCss({ ...style, bold: undefined, italic: undefined, underline: undefined, strike: undefined, script: undefined, link: undefined });
  if (css.length) out = `<span style="${css.join(';')}">${out}</span>`;
  if (style.script) out = `<${style.script === 'super' ? 'sup' : 'sub'}>${out}</${style.script === 'super' ? 'sup' : 'sub'}>`;
  if (style.strike) out = `<s>${out}</s>`;
  if (style.underline) out = `<u>${out}</u>`;
  if (style.italic) out = `<em>${out}</em>`;
  if (style.bold) out = `<strong>${out}</strong>`;
  if (style.link) out = `<a href="${escapeAttr(style.link)}">${out}</a>`;
  return out;
}

function textCss(style: TextStyle): string[] {
  const css: string[] = [];
  if (style.font) css.push(`font-family:${cssFont(style.font)}`);
  if (style.size) css.push(`font-size:${style.size}pt`);
  if (style.color) css.push(`color:${style.color}`);
  if (style.highlight) css.push(`background-color:${style.highlight}`);
  if (style.bold) css.push('font-weight:700');
  if (style.italic) css.push('font-style:italic');
  const deco = [style.underline ? 'underline' : '', style.strike ? 'line-through' : ''].filter(Boolean);
  if (deco.length) css.push(`text-decoration:${deco.join(' ')}`);
  if (style.smallCaps) css.push('font-variant:small-caps');
  if (style.allCaps) css.push('text-transform:uppercase');
  if (style.spacing) css.push(`letter-spacing:${style.spacing}pt`);
  return css;
}

function borderCss(line: BorderLine): string {
  if (!line.width) return 'none';
  return `${line.width}pt ${line.style ?? 'solid'} ${line.color}`;
}

function cssFont(font: string): string {
  return /^[a-z-]+$/i.test(font) ? font : `'${font.replace(/['\\]/g, '')}'`;
}

function pt(n: number): string {
  return `${Math.round(n * 100) / 100}pt`;
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => HTML_ESCAPES[c]!);
}

export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
