/**
 * Convert a legacy `project_documents` row into a .docx Buffer.
 *
 * WeldFlow's new document surface stores each document as a .docx in R2 and
 * opens it via mammoth (DOCX -> HTML -> BlockNote). Legacy documents live in
 * the `project_documents` table with their body in one of three shapes:
 *
 *   - `content_json`  — BlockNote block JSON (the block editor's native form)
 *   - `content`       — HTML / markdown / stringified-JSON text, keyed by
 *                       `content_type` ('html' | 'markdown' | 'json')
 *   - `pages`         — multi-page documents: an array of { title, content }
 *                       where each page's content is HTML
 *
 * This module normalises any of those into HTML, then builds a Word document
 * with the `docx` library so it round-trips through mammoth on open. The
 * conversion only needs to preserve the *content* — formatting fidelity is
 * best-effort and every risky branch (images, tables) degrades gracefully
 * rather than throwing, so one malformed node never loses a whole document.
 */

import { parseDocument } from 'htmlparser2';
import { marked } from 'marked';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ExternalHyperlink,
  ImageRun,
  Table,
  TableRow,
  TableCell,
  HeadingLevel,
  LevelFormat,
  AlignmentType,
  WidthType,
  ShadingType,
  PageBreak,
} from 'docx';

// ---------------------------------------------------------------------------
// Loose DOM / block types (htmlparser2 + BlockNote JSON are untyped here)
// ---------------------------------------------------------------------------

interface DomNode {
  type: string; // 'tag' | 'text' | 'root' | 'comment' | 'script' | 'style' | ...
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: DomNode[];
}

interface InlineStyles {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  textColor?: string;
  backgroundColor?: string;
}

interface InlineItem {
  type?: string;
  text?: string;
  href?: string;
  styles?: InlineStyles;
  content?: InlineItem[];
}

interface BlockLike {
  type?: string;
  props?: Record<string, unknown>;
  content?: InlineItem[] | { rows?: Array<{ cells?: unknown[] }> };
  children?: BlockLike[];
}

interface DocSection {
  title?: string;
  html: string;
}

export interface DocLike {
  title?: string | null;
  content?: string | null;
  contentType?: string | null;
  contentJson?: unknown;
  pages?: unknown;
}

type InlineRun = TextRun | ExternalHyperlink | ImageRun;
type BlockRun = Paragraph | Table;

interface Ctx {
  /** Monotonic counter giving each ordered list its own restarting instance. */
  orderedInstance: { v: number };
}

const ORDERED_REF = 'ws-ol';

// ===========================================================================
// Public API
// ===========================================================================

/** Normalise a legacy document row into one-or-more HTML sections. */
export function resolveSections(doc: DocLike): DocSection[] {
  const pages = Array.isArray(doc.pages)
    ? (doc.pages as Array<{ title?: string; content?: string }>)
    : null;

  if (pages && pages.length > 0) {
    const sections = pages.map((p) => ({
      title: p.title,
      html: coerceToHtml(p.content ?? '', doc.contentType ?? null),
    }));
    return sections.length > 0 ? sections : [{ html: '' }];
  }

  if (Array.isArray(doc.contentJson) && (doc.contentJson as unknown[]).length > 0) {
    return [{ html: blocksToHtml(doc.contentJson as BlockLike[]) }];
  }

  if (typeof doc.content === 'string' && doc.content.trim().length > 0) {
    return [{ html: coerceToHtml(doc.content, doc.contentType ?? null) }];
  }

  return [{ html: '' }];
}

/** Build a .docx Buffer from pre-resolved HTML sections (one per page). */
export async function buildDocxBuffer(sections: DocSection[]): Promise<Buffer> {
  const ctx: Ctx = { orderedInstance: { v: 0 } };
  const children: BlockRun[] = [];

  sections.forEach((sec, idx) => {
    if (idx > 0) {
      children.push(new Paragraph({ children: [new PageBreak()] }));
    }
    // Multi-page docs lose their per-page identity in the one-file model, so
    // keep each page's title as a heading to preserve navigation.
    if (sections.length > 1 && sec.title && sec.title.trim()) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [new TextRun(sec.title.trim())],
        }),
      );
    }
    children.push(...nodesToBlocks(parseHtml(sec.html), ctx));
  });

  // docx requires at least one child in a section.
  if (children.length === 0) children.push(new Paragraph({}));

  const document = new Document({
    numbering: {
      config: [{ reference: ORDERED_REF, levels: orderedLevels() }],
    },
    sections: [{ children }],
  });

  return Packer.toBuffer(document);
}

/** Convenience: resolve + build in one call. */
export async function convertDocumentToDocx(doc: DocLike): Promise<Buffer> {
  return buildDocxBuffer(resolveSections(doc));
}

// ===========================================================================
// content -> HTML
// ===========================================================================

function coerceToHtml(raw: string, contentType: string | null): string {
  const s = (raw || '').trim();
  if (!s) return '';

  // Stringified BlockNote JSON (either flagged via content_type, or detected).
  if (contentType === 'json' || s.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(s);
      if (Array.isArray(parsed)) return blocksToHtml(parsed as BlockLike[]);
    } catch {
      /* not JSON — fall through */
    }
  }

  if (contentType === 'markdown') {
    try {
      return String(marked.parse(s, { async: false }));
    } catch {
      return plainTextToHtml(s);
    }
  }

  return looksLikeHtml(s) ? s : plainTextToHtml(s);
}

function looksLikeHtml(s: string): boolean {
  return /<[a-z!/][^>]*>/i.test(s);
}

function plainTextToHtml(s: string): string {
  return s
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

// ===========================================================================
// BlockNote JSON -> HTML
// ===========================================================================

function blocksToHtml(blocks: BlockLike[]): string {
  let html = '';
  let i = 0;
  while (i < blocks.length) {
    const kind = listKind(blocks[i]?.type);
    if (kind) {
      const tag = kind;
      let items = '';
      while (i < blocks.length && listKind(blocks[i]?.type) === kind) {
        items += `<li>${listItemHtml(blocks[i]!)}</li>`;
        i++;
      }
      html += `<${tag}>${items}</${tag}>`;
      continue;
    }
    html += blockToHtml(blocks[i]!);
    i++;
  }
  return html;
}

function listKind(type: string | undefined): 'ul' | 'ol' | null {
  if (type === 'numberedListItem') return 'ol';
  if (type === 'bulletListItem' || type === 'checkListItem') return 'ul';
  return null;
}

function listItemHtml(b: BlockLike): string {
  const prefix =
    b.type === 'checkListItem' ? (b.props?.checked ? '☑ ' : '☐ ') : '';
  const inline = inlineToHtml(asInline(b.content));
  const childHtml = b.children && b.children.length ? blocksToHtml(b.children) : '';
  return `${prefix}${inline}${childHtml}`;
}

function blockToHtml(b: BlockLike): string {
  const inline = inlineToHtml(asInline(b.content));
  const childHtml = b.children && b.children.length ? blocksToHtml(b.children) : '';
  switch (b.type) {
    case 'heading': {
      const level = clamp(Number(b.props?.level) || 1, 1, 6);
      return `<h${level}>${inline}</h${level}>${childHtml}`;
    }
    case 'quote':
      return `<blockquote>${inline}${childHtml}</blockquote>`;
    case 'codeBlock':
      return `<pre><code>${escapeHtml(plainText(asInline(b.content)))}</code></pre>`;
    case 'image': {
      const url = typeof b.props?.url === 'string' ? b.props.url : '';
      const caption = typeof b.props?.caption === 'string' ? b.props.caption : '';
      return url ? `<img src="${escapeAttr(url)}" alt="${escapeAttr(caption)}">` : '';
    }
    case 'video':
    case 'audio':
    case 'file': {
      const url = typeof b.props?.url === 'string' ? b.props.url : '';
      const name = typeof b.props?.name === 'string' ? b.props.name : url;
      return url ? `<p><a href="${escapeAttr(url)}">${escapeHtml(name)}</a></p>` : '';
    }
    case 'table':
      return tableBlockToHtml(b.content);
    case 'divider':
    case 'horizontalRule':
      return '<hr>';
    case 'paragraph':
    default:
      return `<p>${inline}</p>${childHtml}`;
  }
}

function asInline(content: BlockLike['content']): InlineItem[] {
  return Array.isArray(content) ? content : [];
}

function inlineToHtml(items: InlineItem[]): string {
  let html = '';
  for (const item of items) {
    if (item.type === 'link') {
      const inner = inlineToHtml(item.content ?? []);
      html += item.href ? `<a href="${escapeAttr(item.href)}">${inner}</a>` : inner;
    } else if (typeof item.text === 'string') {
      html += styleWrap(item.text, item.styles);
    }
  }
  return html;
}

function styleWrap(text: string, styles: InlineStyles | undefined): string {
  let h = escapeHtml(text);
  if (!styles) return h;
  if (styles.code) h = `<code>${h}</code>`;
  if (styles.bold) h = `<strong>${h}</strong>`;
  if (styles.italic) h = `<em>${h}</em>`;
  if (styles.underline) h = `<u>${h}</u>`;
  if (styles.strike) h = `<s>${h}</s>`;
  const css: string[] = [];
  if (styles.textColor && styles.textColor !== 'default') css.push(`color:${styles.textColor}`);
  if (styles.backgroundColor && styles.backgroundColor !== 'default')
    css.push(`background-color:${styles.backgroundColor}`);
  if (css.length) h = `<span style="${css.join(';')}">${h}</span>`;
  return h;
}

function plainText(items: InlineItem[]): string {
  return items
    .map((i) => (i.type === 'link' ? plainText(i.content ?? []) : i.text ?? ''))
    .join('');
}

function tableBlockToHtml(content: BlockLike['content']): string {
  if (Array.isArray(content) || !content || !Array.isArray(content.rows)) return '';
  const rows = content.rows
    .map((row) => {
      const cells = (row.cells ?? [])
        .map((cell) => `<td>${inlineToHtml(normalizeCell(cell))}</td>`)
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');
  return rows ? `<table>${rows}</table>` : '';
}

function normalizeCell(cell: unknown): InlineItem[] {
  if (Array.isArray(cell)) return cell as InlineItem[];
  if (cell && typeof cell === 'object' && Array.isArray((cell as { content?: unknown }).content)) {
    return (cell as { content: InlineItem[] }).content;
  }
  return [];
}

// ===========================================================================
// HTML -> docx
// ===========================================================================

function parseHtml(html: string): DomNode[] {
  if (!html || !html.trim()) return [];
  const root = parseDocument(html, { decodeEntities: true });
  return (root.children as unknown as DomNode[]) ?? [];
}

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside',
  'figure', 'figcaption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol',
  'li', 'blockquote', 'pre', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td',
  'th', 'hr', 'dl', 'dt', 'dd',
]);

function isBlock(n: DomNode): boolean {
  return n.type === 'tag' && !!n.name && BLOCK_TAGS.has(n.name);
}

function nodesToBlocks(nodes: DomNode[], ctx: Ctx): BlockRun[] {
  const out: BlockRun[] = [];
  let buffer: DomNode[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    if (nodesHaveInk(buffer)) {
      const runs = inlineRuns(buffer, {});
      if (runs.length) out.push(new Paragraph({ children: runs }));
    }
    buffer = [];
  };

  for (const node of nodes) {
    if (node.type === 'tag' && isBlock(node)) {
      flush();
      out.push(...convertBlock(node, ctx));
    } else if (node.type === 'tag' || node.type === 'text') {
      buffer.push(node);
    }
  }
  flush();
  return out;
}

function convertBlock(node: DomNode, ctx: Ctx): BlockRun[] {
  const name = node.name ?? '';
  const kids = node.children ?? [];

  switch (name) {
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      if (!nodesHaveInk(kids)) return [];
      return [new Paragraph({ heading: headingLevel(name), children: inlineRuns(kids, {}) })];
    }
    case 'p': {
      const runs = inlineRuns(kids, {});
      return runs.length ? [new Paragraph({ children: runs })] : [];
    }
    case 'blockquote':
      return [
        new Paragraph({
          children: inlineRuns(kids, { italic: true }),
          indent: { left: 720 },
        }),
      ];
    case 'pre':
      return [preToParagraph(node)];
    case 'ul':
      return listToBlocks(node, false, 0, ctx, 0);
    case 'ol': {
      ctx.orderedInstance.v += 1;
      return listToBlocks(node, true, 0, ctx, ctx.orderedInstance.v);
    }
    case 'table':
      return tableToBlocks(node, ctx);
    case 'hr':
      return [];
    default:
      // Transparent container (div/section/li/dl/...) — recurse.
      return nodesToBlocks(kids, ctx);
  }
}

function listToBlocks(
  listNode: DomNode,
  ordered: boolean,
  level: number,
  ctx: Ctx,
  instance: number,
): BlockRun[] {
  const out: BlockRun[] = [];
  const items = (listNode.children ?? []).filter((c) => c.type === 'tag' && c.name === 'li');

  for (const li of items) {
    const inlineParts: DomNode[] = [];
    const nestedLists: DomNode[] = [];
    for (const c of li.children ?? []) {
      if (c.type === 'tag' && (c.name === 'ul' || c.name === 'ol')) nestedLists.push(c);
      else inlineParts.push(c);
    }

    const runs = inlineRuns(inlineParts, {});
    out.push(
      new Paragraph({
        children: runs.length ? runs : [new TextRun('')],
        ...(ordered
          ? { numbering: { reference: ORDERED_REF, level, instance } }
          : { bullet: { level } }),
      }),
    );

    for (const nested of nestedLists) {
      if (nested.name === 'ol') {
        ctx.orderedInstance.v += 1;
        out.push(...listToBlocks(nested, true, level + 1, ctx, ctx.orderedInstance.v));
      } else {
        out.push(...listToBlocks(nested, false, level + 1, ctx, instance));
      }
    }
  }
  return out;
}

function tableToBlocks(node: DomNode, ctx: Ctx): BlockRun[] {
  try {
    const trs = collectDescendants(node, 'tr');
    const rows: TableRow[] = [];
    for (const tr of trs) {
      const cellNodes = (tr.children ?? []).filter(
        (c) => c.type === 'tag' && (c.name === 'td' || c.name === 'th'),
      );
      if (cellNodes.length === 0) continue;
      const cells = cellNodes.map((cell) => {
        const blocks = nodesToBlocks(cell.children ?? [], ctx);
        return new TableCell({ children: blocks.length ? blocks : [new Paragraph({})] });
      });
      rows.push(new TableRow({ children: cells }));
    }
    if (rows.length === 0) return [];
    return [new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } })];
  } catch {
    return [new Paragraph({ children: [new TextRun('[table omitted]')] })];
  }
}

function preToParagraph(node: DomNode): Paragraph {
  const text = textContent(node);
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const runs: TextRun[] = [];
  lines.forEach((line, idx) => {
    runs.push(new TextRun({ text: line, font: 'Courier New' }));
    if (idx < lines.length - 1) runs.push(new TextRun({ break: 1 }));
  });
  return new Paragraph({
    children: runs.length ? runs : [new TextRun('')],
    shading: { type: ShadingType.SOLID, color: 'auto', fill: 'F3F4F6' },
  });
}

// --- inline ---------------------------------------------------------------

function inlineRuns(nodes: DomNode[], fmt: InlineStyles): InlineRun[] {
  const out: InlineRun[] = [];
  for (const node of nodes) {
    if (node.type === 'text') {
      const t = (node.data ?? '').replace(/\s+/g, ' ');
      if (t.length) out.push(makeRun(t, fmt));
      continue;
    }
    if (node.type !== 'tag') continue;

    const kids = node.children ?? [];
    switch (node.name) {
      case 'b': case 'strong':
        out.push(...inlineRuns(kids, { ...fmt, bold: true })); break;
      case 'i': case 'em':
        out.push(...inlineRuns(kids, { ...fmt, italic: true })); break;
      case 'u': case 'ins':
        out.push(...inlineRuns(kids, { ...fmt, underline: true })); break;
      case 's': case 'strike': case 'del':
        out.push(...inlineRuns(kids, { ...fmt, strike: true })); break;
      case 'code': case 'kbd': case 'samp': case 'tt':
        out.push(...inlineRuns(kids, { ...fmt, code: true })); break;
      case 'br':
        out.push(new TextRun({ break: 1 })); break;
      case 'a': {
        const href = node.attribs?.href;
        const inner = inlineRuns(kids, { ...fmt, underline: true, textColor: '0563C1' });
        if (href && inner.length) {
          out.push(new ExternalHyperlink({ children: inner, link: href }));
        } else {
          out.push(...inner);
        }
        break;
      }
      case 'img': {
        const run = imageRun(node);
        if (run) out.push(run);
        break;
      }
      case 'span': case 'font': case 'mark': case 'small': case 'big':
      case 'label': case 'abbr': case 'cite': case 'q': {
        const merged = mergeStyle(fmt, node.attribs?.style, node.name);
        out.push(...inlineRuns(kids, merged));
        break;
      }
      default:
        out.push(...inlineRuns(kids, fmt));
    }
  }
  return out;
}

function makeRun(text: string, fmt: InlineStyles): TextRun {
  return new TextRun({
    text,
    bold: fmt.bold,
    italics: fmt.italic,
    underline: fmt.underline ? {} : undefined,
    strike: fmt.strike,
    font: fmt.code ? 'Courier New' : undefined,
    color: fmt.textColor && isHexColor(fmt.textColor) ? normalizeHex(fmt.textColor) : undefined,
    shading:
      fmt.backgroundColor && isHexColor(fmt.backgroundColor)
        ? { type: ShadingType.SOLID, color: 'auto', fill: normalizeHex(fmt.backgroundColor) }
        : undefined,
  });
}

function mergeStyle(fmt: InlineStyles, style: string | undefined, tag: string): InlineStyles {
  const merged: InlineStyles = { ...fmt };
  if (tag === 'mark') merged.backgroundColor = 'FFFF00';
  if (!style) return merged;
  const decls = style.split(';');
  for (const decl of decls) {
    const [propRaw, valRaw] = decl.split(':');
    if (!propRaw || !valRaw) continue;
    const prop = propRaw.trim().toLowerCase();
    const val = valRaw.trim();
    if (prop === 'color' && isHexColor(val)) merged.textColor = val;
    else if (prop === 'background-color' && isHexColor(val)) merged.backgroundColor = val;
    else if (prop === 'font-weight' && (val === 'bold' || Number(val) >= 600)) merged.bold = true;
    else if (prop === 'font-style' && val === 'italic') merged.italic = true;
    else if (prop === 'text-decoration' && val.includes('underline')) merged.underline = true;
    else if (prop === 'text-decoration' && val.includes('line-through')) merged.strike = true;
  }
  return merged;
}

// --- images ----------------------------------------------------------------

function imageRun(node: DomNode): InlineRun | null {
  const src = node.attribs?.src ?? '';
  if (!src) return null;
  try {
    if (src.startsWith('data:')) {
      const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(src);
      if (!match) return imagePlaceholder(src);
      const mime = match[1] ?? 'image/png';
      const isBase64 = !!match[2];
      const payload = match[3] ?? '';
      const type = mimeToImageType(mime);
      if (!type) return imagePlaceholder(src);
      const data = isBase64
        ? Buffer.from(payload, 'base64')
        : Buffer.from(decodeURIComponent(payload), 'utf8');
      if (data.length === 0) return imagePlaceholder(src);
      const dim = sniffDimensions(data, type) ?? { width: 400, height: 300 };
      return new ImageRun({ type, data, transformation: scaleToMax(dim, 600) });
    }
    // Remote URLs are not fetched during migration — keep the link instead.
    return imagePlaceholder(src);
  } catch {
    return new TextRun('[image]');
  }
}

function imagePlaceholder(src: string): InlineRun {
  if (!src) return new TextRun('[image]');
  return new ExternalHyperlink({
    children: [new TextRun({ text: '[image]', color: '0563C1', underline: {} })],
    link: src,
  });
}

function mimeToImageType(mime: string): 'png' | 'jpg' | 'gif' | 'bmp' | null {
  const m = mime.toLowerCase();
  if (m === 'image/png') return 'png';
  if (m === 'image/jpeg' || m === 'image/jpg') return 'jpg';
  if (m === 'image/gif') return 'gif';
  if (m === 'image/bmp') return 'bmp';
  return null;
}

function sniffDimensions(
  buf: Buffer,
  type: 'png' | 'jpg' | 'gif' | 'bmp',
): { width: number; height: number } | null {
  try {
    if (type === 'png' && buf.length >= 24) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (type === 'gif' && buf.length >= 10) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (type === 'bmp' && buf.length >= 26) {
      return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
    }
    if (type === 'jpg') {
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) {
          off += 1;
          continue;
        }
        const marker = buf[off + 1]!;
        if (marker >= 0xc0 && marker <= 0xc3) {
          return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
        }
        off += 2 + buf.readUInt16BE(off + 2);
      }
    }
  } catch {
    return null;
  }
  return null;
}

function scaleToMax(
  dim: { width: number; height: number },
  maxW: number,
): { width: number; height: number } {
  if (!dim.width || !dim.height) return { width: maxW, height: Math.round(maxW * 0.75) };
  if (dim.width <= maxW) return dim;
  const ratio = maxW / dim.width;
  return { width: maxW, height: Math.max(1, Math.round(dim.height * ratio)) };
}

// ===========================================================================
// Small helpers
// ===========================================================================

function headingLevel(tag: string): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  switch (tag) {
    case 'h1': return HeadingLevel.HEADING_1;
    case 'h2': return HeadingLevel.HEADING_2;
    case 'h3': return HeadingLevel.HEADING_3;
    case 'h4': return HeadingLevel.HEADING_4;
    case 'h5': return HeadingLevel.HEADING_5;
    default: return HeadingLevel.HEADING_6;
  }
}

function orderedLevels() {
  return Array.from({ length: 9 }, (_, level) => ({
    level,
    format: LevelFormat.DECIMAL,
    text: `%${level + 1}.`,
    alignment: AlignmentType.START,
    style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
  }));
}

function nodesHaveInk(nodes: DomNode[]): boolean {
  for (const node of nodes) {
    if (node.type === 'text' && /\S/.test(node.data ?? '')) return true;
    if (node.type === 'tag') {
      if (node.name === 'img') return true;
      if (nodesHaveInk(node.children ?? [])) return true;
    }
  }
  return false;
}

function textContent(node: DomNode): string {
  if (node.type === 'text') return node.data ?? '';
  return (node.children ?? []).map(textContent).join('');
}

function collectDescendants(node: DomNode, name: string): DomNode[] {
  const out: DomNode[] = [];
  for (const child of node.children ?? []) {
    if (child.type === 'tag' && child.name === name) out.push(child);
    else out.push(...collectDescendants(child, name));
  }
  return out;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function isHexColor(v: string): boolean {
  return /^#?[0-9a-fA-F]{3}$|^#?[0-9a-fA-F]{6}$/.test(v.trim());
}

function normalizeHex(v: string): string {
  let h = v.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return h.toUpperCase();
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
