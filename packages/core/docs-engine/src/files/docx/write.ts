/**
 * Writing a document as .docx (Office Open XML WordprocessingML): the body
 * with its paragraphs, runs, links, fields, images, footnotes and tables
 * (merged cells, header rows, tables in cells), the named styles, the list
 * definitions, and every section with its page setup and headers/footers.
 *
 * Word's model differs from the engine's in a few places, bridged here:
 * - a section ends with a `w:sectPr` in the last paragraph of the section
 *   (the engine has a section-break character), and the last section's sits
 *   at the end of the body;
 * - a horizontal rule is an empty paragraph with a bottom border;
 * - a checklist is a bullet list with ☐, and ticked items use a second
 *   numbering instance whose bullet is ☑;
 * - a cell (and the body) must end with a paragraph, so one follows a table
 *   that would otherwise come last;
 * - suggestions are revisions and comment threads are comments (see
 *   `write-review.ts`).
 */

import { XML_HEADER, attrs, esc, writeZip } from '@weldsuite/zip-xml';
import type { Content } from '../../model/content';
import type { DocModel, DocSnapshot } from '../../model/document';
import {
  BODY,
  FINAL_SECTION,
  HEADER_VARIANTS,
  footnoteStoryId,
  headerStoryId,
  type FieldObject,
  type ImageObject,
  type ObjectData,
  type SectionProps,
  type SectionStart,
  type TableData,
} from '../../model/objects';
import type { CellProps } from '../../model/objects';
import type { ParaProps } from '../../model/styles';
import { toBlocks, type Block, type BookmarkRange, type Inline, type ParagraphBlock, type TableBlock } from '../../serialize/blocks';
import { EMU_PER_POINT, NS, REL, hex, imageExtension, pageFmt, twips } from './convert';
import type { WriteDocxOptions } from './types';
import { bordersXml, numberingIds, numberingXml, pPrXml, rPrXml, stylesXml, wordStyleIds, type FormatContext, type PPrExtras } from './write-format';
import { ReviewWriter, type Revision } from './write-review';

const SAFE_LINK = /^(https?:|mailto:|tel:)/i;
const DEFAULT_TABLE_BORDER = { width: 0.75, color: '#000000' };
const DEFAULT_CELL_PADDING = 5;
const ROOT_NS = `xmlns:w="${NS.w}" xmlns:r="${NS.r}" xmlns:wp="${NS.wp}" xmlns:a="${NS.a}" xmlns:pic="${NS.pic}"`;

export async function writeDocx(doc: DocModel, options: WriteDocxOptions = {}): Promise<Uint8Array> {
  const snapshot = doc.toSnapshot();
  const media = await fetchImages(snapshot, options.images);
  const writer = new DocxWriter(snapshot, media);
  const files = writer.write(options.title, options.date ?? new Date());
  return writeZip(files, { date: options.date });
}

interface Media {
  name: string;
  bytes: Uint8Array;
  mime: string;
}

/** Fetches every image the document shows once, before writing (writing itself is synchronous). */
async function fetchImages(snapshot: DocSnapshot, fetch: WriteDocxOptions['images']): Promise<Map<string, Media>> {
  const out = new Map<string, Media>();
  if (!fetch) return out;
  const srcs = new Set<string>();
  for (const story of Object.values(snapshot.stories)) {
    for (const [, obj] of story.objects ?? []) if (obj.kind === 'image') srcs.add(obj.src);
  }
  let n = 0;
  for (const src of srcs) {
    const got = await fetch(src).catch(() => null);
    const ext = got && imageExtension(got.mime);
    if (!got || !ext) continue;
    out.set(src, { name: `image${++n}.${ext}`, bytes: got.bytes, mime: got.mime });
  }
  return out;
}

interface Relationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

/** One XML part of the package and the relationships it owns. */
class Part {
  readonly rels: Relationship[] = [];

  constructor(readonly path: string) {}

  rel(type: string, target: string, external = false): string {
    const found = this.rels.find((r) => r.type === type && r.target === target && r.external === external);
    if (found) return found.id;
    const id = `rId${this.rels.length + 1}`;
    this.rels.push({ id, type, target, external });
    return id;
  }

  relsXml(): string {
    const items = this.rels
      .map((r) => `<Relationship${attrs({ Id: r.id, Type: r.type, Target: r.target, TargetMode: r.external ? 'External' : undefined })}/>`)
      .join('');
    return `${XML_HEADER}<Relationships xmlns="${NS.rels}">${items}</Relationships>`;
  }

  get relsPath(): string {
    const slash = this.path.lastIndexOf('/');
    return `${this.path.slice(0, slash + 1)}_rels/${this.path.slice(slash + 1)}.rels`;
  }
}

interface Section {
  id: string;
  props: SectionProps;
  /** How this section starts (Word's `w:type`; the engine keeps it on the break before). */
  start: SectionStart;
}

class DocxWriter {
  private readonly ctx: FormatContext;
  private readonly all: Pick<Content, 'tables' | 'stories'>;
  private readonly sections: Section[];
  private readonly document = new Part('word/document.xml');
  private readonly headerParts: { part: Part; xml: string; kind: 'header' | 'footer' }[] = [];
  private readonly footnotes: string[] = [];
  private readonly footnotesPart = new Part('word/footnotes.xml');
  private readonly usedMedia = new Set<string>();
  private sectionIndex = 0;
  private drawingId = 0;
  /** Bookmarks by story, and Word's numeric id for each. */
  private readonly bookmarks = new Map<string, BookmarkRange[]>();
  private readonly bookmarkIds = new Map<string, number>();
  private readonly review: ReviewWriter;

  constructor(
    private readonly snapshot: DocSnapshot,
    private readonly media: Map<string, Media>,
  ) {
    this.ctx = {
      styles: snapshot.styles,
      lists: snapshot.lists,
      styleIds: wordStyleIds(snapshot.styles),
      numIds: numberingIds(snapshot.lists),
    };
    this.all = { tables: snapshot.tables, stories: snapshot.stories };
    this.sections = [];
    let start: SectionStart = 'nextPage';
    for (const [, obj] of snapshot.stories[BODY]?.objects ?? []) {
      if (obj.kind !== 'sectionBreak') continue;
      this.sections.push({ id: obj.id, props: obj.section, start });
      start = obj.start;
    }
    this.sections.push({ id: FINAL_SECTION, props: snapshot.props.section, start });
    for (const a of snapshot.anchors) {
      if (a.kind !== 'bookmark') continue;
      const list = this.bookmarks.get(a.story);
      if (list) list.push(a);
      else this.bookmarks.set(a.story, [a]);
    }
    this.review = new ReviewWriter(snapshot.comments ?? [], snapshot.anchors);
  }

  write(title: string | undefined, date: Date): { name: string; data: Uint8Array | string }[] {
    const body = this.storyBlocks(BODY);
    let bodyXml = this.blocksXml(body, this.document, true);
    bodyXml += this.sectPr(this.sections[this.sections.length - 1]!);
    const background = this.snapshot.props.section.background;
    const backgroundXml = background ? `<w:background w:color="${hex(background)}"/>` : '';
    const documentXml = `${XML_HEADER}<w:document ${ROOT_NS}>${backgroundXml}<w:body>${bodyXml}</w:body></w:document>`;

    this.document.rel(REL.styles, 'styles.xml');
    this.document.rel(REL.numbering, 'numbering.xml');
    this.document.rel(REL.settings, 'settings.xml');
    if (this.footnotes.length) this.document.rel(REL.footnotes, 'footnotes.xml');
    if (this.review.hasComments) {
      this.document.rel(REL.comments, 'comments.xml');
      this.document.rel(REL.commentsExtended, 'commentsExtended.xml');
    }

    const files: { name: string; data: Uint8Array | string }[] = [
      { name: '[Content_Types].xml', data: this.contentTypes() },
      { name: '_rels/.rels', data: ROOT_RELS },
      { name: 'docProps/core.xml', data: coreXml(title, date) },
      { name: 'docProps/app.xml', data: `${XML_HEADER}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>WeldDocs</Application></Properties>` },
      { name: 'word/document.xml', data: documentXml },
      { name: this.document.relsPath, data: this.document.relsXml() },
      { name: 'word/styles.xml', data: stylesXml(this.ctx) },
      { name: 'word/numbering.xml', data: numberingXml(this.snapshot.lists, this.ctx.numIds) },
      { name: 'word/settings.xml', data: this.settingsXml() },
    ];
    if (this.footnotes.length) {
      files.push({ name: 'word/footnotes.xml', data: this.footnotesXml() });
      if (this.footnotesPart.rels.length) files.push({ name: this.footnotesPart.relsPath, data: this.footnotesPart.relsXml() });
    }
    if (this.review.hasComments) {
      const parts = this.review.parts();
      files.push({ name: 'word/comments.xml', data: parts.comments }, { name: 'word/commentsExtended.xml', data: parts.extended });
    }
    for (const h of this.headerParts) {
      files.push({ name: h.part.path, data: h.xml });
      if (h.part.rels.length) files.push({ name: h.part.relsPath, data: h.part.relsXml() });
    }
    for (const src of this.usedMedia) {
      const m = this.media.get(src)!;
      files.push({ name: `word/media/${m.name}`, data: m.bytes });
    }
    return files;
  }

  private storyBlocks(storyId: string): Block[] {
    const story = this.snapshot.stories[storyId];
    if (!story) return [];
    return toBlocks(
      { ...story, ...this.all },
      { story: storyId, bookmarks: (id) => this.bookmarks.get(id) ?? [], comments: (id) => this.review.commentRanges(id), markStyles: true },
    ).blocks;
  }

  // ---------------------------------------------------------------- blocks

  /** Blocks as XML; a container never ends with a table (Word needs a paragraph last). */
  private blocksXml(blocks: Block[], part: Part, sections = false, lead = ''): string {
    let out = '';
    let first = true;
    for (const block of blocks) {
      if (block.type === 'paragraph') {
        out += this.paragraphXml(block, part, sections, first ? lead : '');
      } else {
        if (first && lead) out += `<w:p>${lead}</w:p>`;
        out += this.tableXml(block, part);
      }
      first = false;
    }
    if (first) out += `<w:p>${lead}</w:p>`;
    else if (blocks[blocks.length - 1]!.type === 'table') out += '<w:p/>';
    return out;
  }

  /**
   * A paragraph, split where a horizontal rule (its own bordered paragraph)
   * or a section break (ends the paragraph with the section's `w:sectPr`)
   * falls inside it.
   */
  private paragraphXml(block: ParagraphBlock, part: Part, sections: boolean, lead: string): string {
    const p = new ParagraphXml(block.props, lead, this.ctx, (inlines) => this.runsXml(inlines, part), this.review.markRPr(block.markStyle));
    for (const inline of block.inlines) {
      if (isObjectOf(inline, 'hr')) p.rule();
      else if (isObjectOf(inline, 'sectionBreak')) {
        if (sections && this.sectionIndex < this.sections.length - 1) p.flush(this.sectPr(this.sections[this.sectionIndex++]!));
      } else p.add(inline);
    }
    return p.finish();
  }

  /** Runs, in hyperlinks and (inside those) in the revisions of suggested text. */
  private runsXml(inlines: Inline[], part: Part): string {
    let out = '';
    let link: string | undefined;
    let rev: Revision | null = null;
    for (const inline of inlines) {
      const target = inline.style.link;
      if (target !== link) {
        const open = this.hyperlinkOpen(target, part);
        out += closeRevision(rev) + closeLink(link) + open;
        rev = null;
        link = open ? target : undefined;
      }
      const next = this.revisionOf(inline, rev);
      if (next !== rev) out += closeRevision(rev) + openRevision(next);
      rev = next;
      out += this.inlineXml(inline, part, rev);
    }
    return out + closeRevision(rev) + closeLink(link);
  }

  /** The revision an inline is written in: its suggestion's; a bookmark stays in the open one, a comment mark in none. */
  private revisionOf(inline: Inline, open: Revision | null): Revision | null {
    if (inline.type !== 'bookmark') return this.review.revision(inline.style);
    return inline.kind === 'comment' ? null : open;
  }

  private hyperlinkOpen(target: string | undefined, part: Part): string {
    if (!target) return '';
    if (target.startsWith('#')) return target.length > 1 ? `<w:hyperlink w:anchor="${esc(bookmarkName(target.slice(1)))}" w:history="1">` : '';
    if (!SAFE_LINK.test(target)) return '';
    return `<w:hyperlink r:id="${part.rel(REL.hyperlink, target, true)}" w:history="1">`;
  }

  private inlineXml(inline: Inline, part: Part, rev: Revision | null): string {
    const rPr = rPrXml(inline.style);
    switch (inline.type) {
      case 'text':
        return textRun(rPr, inline.text, rev);
      case 'tab':
        return `<w:r>${rPr}<w:tab/></w:r>`;
      case 'break':
        return `<w:r>${rPr}<w:br/></w:r>`;
      case 'object':
        return this.objectXml(inline.data, rPr, part, rev);
      case 'bookmark':
        return inline.kind === 'comment' ? this.review.commentMark(inline.id, inline.edge) : this.bookmarkXml(inline.id, inline.edge);
    }
  }

  private bookmarkXml(id: string, edge: 'start' | 'end'): string {
    let n = this.bookmarkIds.get(id);
    if (n === undefined) {
      n = this.bookmarkIds.size;
      this.bookmarkIds.set(id, n);
    }
    return edge === 'start' ? `<w:bookmarkStart w:id="${n}" w:name="${esc(bookmarkName(id))}"/>` : `<w:bookmarkEnd w:id="${n}"/>`;
  }

  private objectXml(data: ObjectData, rPr: string, part: Part, rev: Revision | null): string {
    switch (data.kind) {
      case 'image':
        return this.imageXml(data, rPr, part);
      case 'pageBreak':
        return '<w:r><w:br w:type="page"/></w:r>';
      case 'columnBreak':
        return '<w:r><w:br w:type="column"/></w:r>';
      case 'footnote':
        return this.footnoteXml(data.id);
      case 'field': {
        const instr = fieldInstr(data.field, data.format, data.ref);
        const shown = data.field === 'page' || data.field === 'pages' || data.field === 'pageRef' ? '1' : '';
        // A simple field cannot sit in a revision; the run form of a field can.
        if (rev) return complexField(instr, rPr, shown, rev);
        return `<w:fldSimple w:instr="${esc(instr)}">${textRun(rPr, shown, null)}</w:fldSimple>`;
      }
      case 'chip':
        return textRun(rPr, data.label, rev);
      case 'equation':
        return textRun(rPr, data.latex, rev);
      default:
        return '';
    }
  }

  private footnoteXml(id: string): string {
    const blocks = this.storyBlocks(footnoteStoryId(id));
    const n = this.footnotes.length + 1;
    // Reserve the number first: footnotes are numbered in the order their references are written.
    this.footnotes.push('');
    const ref = '<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r>';
    this.footnotes[n - 1] = `<w:footnote w:id="${n}">${this.blocksXml(blocks, this.footnotesPart, false, ref)}</w:footnote>`;
    return `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="${n}"/></w:r>`;
  }

  private imageXml(img: ImageObject, rPr: string, part: Part): string {
    const m = this.media.get(img.src);
    if (!m) return '';
    this.usedMedia.add(img.src);
    const rid = part.rel(REL.image, `media/${m.name}`);
    const id = ++this.drawingId;
    const cx = Math.max(1, Math.round(img.width * EMU_PER_POINT));
    const cy = Math.max(1, Math.round(img.height * EMU_PER_POINT));
    const crop = img.crop
      ? `<a:srcRect${attrs({ l: pct(img.crop.left), t: pct(img.crop.top), r: pct(img.crop.right), b: pct(img.crop.bottom) })}/>`
      : '';
    const line = img.border?.width
      ? `<a:ln w="${Math.round(img.border.width * EMU_PER_POINT)}"><a:solidFill><a:srgbClr val="${hex(img.border.color)}"/></a:solidFill></a:ln>`
      : '';
    const docPr = attrs({ id, name: `Picture ${id}`, descr: img.alt || undefined });
    const inner =
      `<wp:docPr${docPr}/>` +
      '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
      `<a:graphic><a:graphicData uri="${NS.pic}"><pic:pic>` +
      `<pic:nvPicPr><pic:cNvPr id="${id}" name="${esc(m.name)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${rid}"/>${crop}<a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${line}</pic:spPr>` +
      '</pic:pic></a:graphicData></a:graphic>';
    const extent = `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>`;
    if (!img.wrap || img.wrap === 'inline') {
      return `<w:r>${rPr}<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">${extent}${inner}</wp:inline></w:drawing></w:r>`;
    }
    return `<w:r>${rPr}<w:drawing>${anchorOpen(img, id)}${extent}${WRAP_XML[img.wrap]}${inner}</wp:anchor></w:drawing></w:r>`;
  }

  // ---------------------------------------------------------------- tables

  private tableXml(block: TableBlock, part: Part): string {
    const data = block.data;
    const props = data.props ?? {};
    const border = props.border ?? DEFAULT_TABLE_BORDER;
    const padding = twips(props.padding ?? DEFAULT_CELL_PADDING);
    const total = data.cols.reduce((n, c) => n + twips(c.width), 0);
    let tblPr = `<w:tblW w:w="${total}" w:type="dxa"/>`;
    if (props.align && props.align !== 'left') tblPr += `<w:jc w:val="${props.align}"/>`;
    if (props.indent) tblPr += `<w:tblInd w:w="${twips(props.indent)}" w:type="dxa"/>`;
    const all = { top: border, left: border, bottom: border, right: border, insideH: border, insideV: border };
    tblPr += bordersXml('tblBorders', all, ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']);
    tblPr += '<w:tblLayout w:type="fixed"/>';
    tblPr += `<w:tblCellMar><w:top w:w="${padding}" w:type="dxa"/><w:left w:w="${padding}" w:type="dxa"/><w:bottom w:w="${padding}" w:type="dxa"/><w:right w:w="${padding}" w:type="dxa"/></w:tblCellMar>`;
    tblPr += '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>';
    let out = `<w:tbl><w:tblPr>${tblPr}</w:tblPr><w:tblGrid>`;
    for (const c of data.cols) out += `<w:gridCol w:w="${twips(c.width)}"/>`;
    out += '</w:tblGrid>';

    const spans = cellSpans(data);
    block.rows.forEach((row, ri) => {
      const r = data.rows[ri]!;
      let trPr = '';
      if (r.cantSplit) trPr += '<w:cantSplit/>';
      if (r.height) trPr += `<w:trHeight w:val="${twips(r.height)}" w:hRule="atLeast"/>`;
      if (r.header) trPr += '<w:tblHeader/>';
      const trPrXml = trPr ? `<w:trPr>${trPr}</w:trPr>` : '';
      out += `<w:tr>${trPrXml}`;
      let ci = 0;
      while (ci < data.cols.length) {
        const span = spans[ri]![ci]!;
        if (span.kind === 'origin') {
          const cell = row[ci]!;
          const width = data.cols.slice(ci, ci + span.cols).reduce((n, c) => n + twips(c.width), 0);
          out += `<w:tc>${tcPr(cell.props, width, span.cols, span.rows > 1 ? 'restart' : undefined)}${this.blocksXml(cell.blocks, part)}</w:tc>`;
          ci += span.cols;
        } else if (span.kind === 'below') {
          const origin = data.cells?.[`${data.rows[span.row]!.id}:${data.cols[ci]!.id}`] ?? {};
          const width = data.cols.slice(ci, ci + span.cols).reduce((n, c) => n + twips(c.width), 0);
          out += `<w:tc>${tcPr(origin, width, span.cols, 'continue')}<w:p/></w:tc>`;
          ci += span.cols;
        } else {
          // Covered by a merge that does not line up with the grid: an empty cell keeps the row whole.
          out += `<w:tc>${tcPr({}, twips(data.cols[ci]!.width), 1)}<w:p/></w:tc>`;
          ci++;
        }
      }
      out += '</w:tr>';
    });
    return `${out}</w:tbl>`;
  }

  // ---------------------------------------------------------------- sections

  private sectPr(section: Section): string {
    let out = '<w:sectPr>';
    for (const kind of ['header', 'footer'] as const) {
      for (const variant of HEADER_VARIANTS) {
        const storyId = headerStoryId(section.id, kind, variant);
        if (!this.snapshot.stories[storyId]) continue;
        const rid = this.headerPart(kind, storyId);
        out += `<w:${kind}Reference w:type="${variant}" r:id="${rid}"/>`;
      }
    }
    const p = section.props;
    if (section.start !== 'nextPage') out += `<w:type w:val="${section.start}"/>`;
    out += `<w:pgSz${attrs({ 'w:w': twips(p.pageWidth), 'w:h': twips(p.pageHeight), 'w:orient': p.pageWidth > p.pageHeight ? 'landscape' : undefined })}/>`;
    out += `<w:pgMar${attrs({
      'w:top': twips(p.marginTop),
      'w:right': twips(p.marginRight),
      'w:bottom': twips(p.marginBottom),
      'w:left': twips(p.marginLeft),
      'w:header': twips(p.headerMargin),
      'w:footer': twips(p.footerMargin),
      'w:gutter': 0,
    })}/>`;
    if (p.pageNumberStart !== undefined || p.pageNumberFormat) {
      out += `<w:pgNumType${attrs({ 'w:fmt': p.pageNumberFormat ? pageFmt(p.pageNumberFormat) : undefined, 'w:start': p.pageNumberStart })}/>`;
    }
    out += `<w:cols${attrs({ 'w:num': p.columns && p.columns > 1 ? p.columns : undefined, 'w:space': twips(p.columnGap ?? 36) })}/>`;
    if (p.titlePage) out += '<w:titlePg/>';
    return `${out}</w:sectPr>`;
  }

  private headerPart(kind: 'header' | 'footer', storyId: string): string {
    const n = this.headerParts.filter((h) => h.kind === kind).length + 1;
    const part = new Part(`word/${kind}${n}.xml`);
    const tag = kind === 'header' ? 'hdr' : 'ftr';
    // Reserve the slot before writing, so nested parts number in order.
    const entry = { part, xml: '', kind };
    this.headerParts.push(entry);
    // Word has no comments in headers and footers.
    const commentsOn = this.review.commentsOn;
    this.review.commentsOn = false;
    entry.xml = `${XML_HEADER}<w:${tag} ${ROOT_NS}>${this.blocksXml(this.storyBlocks(storyId), part)}</w:${tag}>`;
    this.review.commentsOn = commentsOn;
    return this.document.rel(REL[kind], `${kind}${n}.xml`);
  }

  // ---------------------------------------------------------------- parts

  private settingsXml(): string {
    let out = '<w:zoom w:percent="100"/>';
    if (this.snapshot.props.section.background) out += '<w:displayBackgroundShape/>';
    out += `<w:defaultTabStop w:val="${twips(this.snapshot.props.tabInterval ?? 36)}"/>`;
    if (this.sections.some((s) => s.props.evenAndOdd)) out += '<w:evenAndOddHeaders/>';
    out += '<w:characterSpacingControl w:val="doNotCompress"/>';
    if (this.footnotes.length) out += '<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>';
    out += '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>';
    return `${XML_HEADER}<w:settings xmlns:w="${NS.w}">${out}</w:settings>`;
  }

  private footnotesXml(): string {
    const sep = (type: string, id: number, mark: string) =>
      `<w:footnote w:type="${type}" w:id="${id}"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:${mark}/></w:r></w:p></w:footnote>`;
    return `${XML_HEADER}<w:footnotes ${ROOT_NS}>${sep('separator', -1, 'separator')}${sep('continuationSeparator', 0, 'continuationSeparator')}${this.footnotes.join('')}</w:footnotes>`;
  }

  private contentTypes(): string {
    const main = 'application/vnd.openxmlformats-officedocument.wordprocessingml';
    const exts = new Map<string, string>();
    for (const src of this.usedMedia) {
      const m = this.media.get(src)!;
      exts.set(m.name.slice(m.name.lastIndexOf('.') + 1), m.mime);
    }
    let out = `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`;
    for (const [ext, mime] of exts) out += `<Default Extension="${ext}" ContentType="${esc(mime)}"/>`;
    const override = (part: string, type: string) => `<Override PartName="/${part}" ContentType="${type}"/>`;
    out += override('word/document.xml', `${main}.document.main+xml`);
    out += override('word/styles.xml', `${main}.styles+xml`);
    out += override('word/numbering.xml', `${main}.numbering+xml`);
    out += override('word/settings.xml', `${main}.settings+xml`);
    if (this.footnotes.length) out += override('word/footnotes.xml', `${main}.footnotes+xml`);
    if (this.review.hasComments) {
      out += override('word/comments.xml', `${main}.comments+xml`);
      out += override('word/commentsExtended.xml', `${main}.commentsExtended+xml`);
    }
    for (const h of this.headerParts) out += override(h.part.path, `${main}.${h.kind}+xml`);
    out += override('docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml');
    out += override('docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml');
    return `${XML_HEADER}<Types xmlns="${NS.ct}">${out}</Types>`;
  }
}

// ---------------------------------------------------------------- helpers

const ROOT_RELS =
  `${XML_HEADER}<Relationships xmlns="${NS.rels}">` +
  `<Relationship Id="rId1" Type="${REL.officeDocument}" Target="word/document.xml"/>` +
  `<Relationship Id="rId2" Type="${REL.coreProps}" Target="docProps/core.xml"/>` +
  `<Relationship Id="rId3" Type="${REL.appProps}" Target="docProps/app.xml"/>` +
  '</Relationships>';

function coreXml(title: string | undefined, date: Date): string {
  const when = date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return (
    `${XML_HEADER}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    (title ? `<dc:title>${esc(title)}</dc:title>` : '') +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${when}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${when}</dcterms:modified>` +
    '</cp:coreProperties>'
  );
}

/** Whether an inline is an object of the given kind. */
function isObjectOf(inline: Inline, kind: ObjectData['kind']): boolean {
  return inline.type === 'object' && inline.data.kind === kind;
}

/** A paragraph's properties for a rule split out of it: no list, checkbox or borders of its own. */
function ruleParaProps(props: ParaProps): ParaProps {
  const rest = { ...props };
  delete rest.list;
  delete rest.checked;
  delete rest.borders;
  return rest;
}

/**
 * Writes one engine paragraph as Word paragraphs: split where a horizontal
 * rule (its own bordered paragraph) or a section end falls inside it. The
 * `lead` (a footnote's own number mark) goes into the first one written, the
 * paragraph mark's properties (`mark`) into the last.
 */
class ParagraphXml {
  /** The paragraphs written: properties, and the runs (rendered in order as they come). */
  private readonly paras: { props: ParaProps; extras: PPrExtras; body: string }[] = [];
  private current: Inline[] = [];
  private emitted = false;

  constructor(
    private readonly props: ParaProps,
    private readonly lead: string,
    private readonly ctx: FormatContext,
    private readonly runs: (inlines: Inline[]) => string,
    private readonly mark = '',
  ) {}

  add(inline: Inline): void {
    this.current.push(inline);
  }

  /** Writes the runs collected so far as a paragraph, ending a section when `sectPr` is given. */
  flush(sectPr?: string): void {
    this.paras.push({ props: this.props, extras: { sectPr }, body: this.takeLead() + this.runs(this.current) });
    this.current = [];
  }

  /** A horizontal rule: an empty paragraph with a bottom border, after the runs before it. */
  rule(): void {
    if (this.current.length) this.flush();
    this.paras.push({ props: ruleParaProps(this.props), extras: { borders: { bottom: DEFAULT_TABLE_BORDER } }, body: this.takeLead() });
  }

  finish(): string {
    const last = this.paras[this.paras.length - 1];
    // Range edges after a rule or a section end close in that paragraph rather than open another.
    if (last && this.current.length && this.current.every((i) => i.type === 'bookmark')) {
      last.body += this.runs(this.current);
      this.current = [];
    }
    if (this.current.length || !this.emitted) this.flush();
    const end = this.paras[this.paras.length - 1]!;
    if (this.mark) end.extras = { ...end.extras, markRPr: this.mark };
    return this.paras.map((p) => `<w:p>${pPrXml(p.props, this.ctx, p.extras)}${p.body}</w:p>`).join('');
  }

  private takeLead(): string {
    const lead = this.emitted ? '' : this.lead;
    this.emitted = true;
    return lead;
  }
}

/** A run of text; deleted text (in a `w:del`) is `w:delText`. */
function textRun(rPr: string, text: string, rev: Revision | null): string {
  const tag = rev?.tag === 'del' ? 'w:delText' : 'w:t';
  return `<w:r>${rPr}<${tag} xml:space="preserve">${esc(text)}</${tag}></w:r>`;
}

function openRevision(rev: Revision | null): string {
  return rev ? `<w:${rev.tag}${rev.attrs}>` : '';
}

function closeRevision(rev: Revision | null): string {
  return rev ? `</w:${rev.tag}>` : '';
}

function closeLink(link: string | undefined): string {
  return link === undefined ? '' : '</w:hyperlink>';
}

/** A field as runs (begin, code, separator, shown result, end), the form that can sit in a revision. */
function complexField(instr: string, rPr: string, shown: string, rev: Revision): string {
  const code = rev.tag === 'del' ? 'w:delInstrText' : 'w:instrText';
  const char = (type: string) => `<w:r>${rPr}<w:fldChar w:fldCharType="${type}"/></w:r>`;
  return `${char('begin')}<w:r>${rPr}<${code} xml:space="preserve">${esc(instr)}</${code}></w:r>${char('separate')}${textRun(rPr, shown, rev)}${char('end')}`;
}

/** Word's name for a bookmark: the id itself when Word allows it, else a safe form of it. */
function bookmarkName(id: string): string {
  if (/^[A-Za-z_]\w{0,39}$/.test(id)) return id;
  return `wd_${id.replace(/\W/g, '_')}`.slice(0, 40);
}

const GAP_EMU = Math.round(9 * EMU_PER_POINT);
const WRAP_XML: Record<'square' | 'topBottom' | 'behind' | 'front', string> = {
  square: '<wp:wrapSquare wrapText="bothSides"/>',
  topBottom: '<wp:wrapTopAndBottom/>',
  behind: '<wp:wrapNone/>',
  front: '<wp:wrapNone/>',
};

/** The opening of a floating picture, placed from its paragraph's column and top as in the engine. */
function anchorOpen(img: ImageObject, id: number): string {
  const x = Math.round((img.offsetX ?? 0) * EMU_PER_POINT);
  const y = Math.round((img.offsetY ?? 0) * EMU_PER_POINT);
  const behind = img.wrap === 'behind' ? 1 : 0;
  return (
    `<wp:anchor distT="${GAP_EMU}" distB="${GAP_EMU}" distL="${GAP_EMU}" distR="${GAP_EMU}" simplePos="0" relativeHeight="${251_658_240 + id}" behindDoc="${behind}" locked="0" layoutInCell="1" allowOverlap="1">` +
    '<wp:simplePos x="0" y="0"/>' +
    `<wp:positionH relativeFrom="column"><wp:posOffset>${x}</wp:posOffset></wp:positionH>` +
    `<wp:positionV relativeFrom="paragraph"><wp:posOffset>${y}</wp:posOffset></wp:positionV>`
  );
}

function fieldInstr(field: FieldObject['field'], format: string | undefined, ref: string | undefined): string {
  switch (field) {
    case 'pageRef':
      return ` PAGEREF ${bookmarkName(ref ?? '')} \\h `;
    case 'page':
      return ' PAGE ';
    case 'pages':
      return ' NUMPAGES ';
    case 'title':
      return ' TITLE ';
    case 'date':
      return format ? ` DATE \\@ "${format.replaceAll('"', '')}" ` : ' DATE ';
  }
}

function pct(fraction: number): number {
  return Math.round(Math.min(1, Math.max(0, fraction)) * 100_000);
}

const VALIGN: Record<NonNullable<CellProps['vAlign']>, string> = { top: 'top', middle: 'center', bottom: 'bottom' };

function tcPr(props: CellProps, width: number, gridSpan: number, vMerge?: 'restart' | 'continue'): string {
  let out = `<w:tcW w:w="${width}" w:type="dxa"/>`;
  if (gridSpan > 1) out += `<w:gridSpan w:val="${gridSpan}"/>`;
  if (vMerge === 'restart') out += '<w:vMerge w:val="restart"/>';
  else if (vMerge === 'continue') out += '<w:vMerge/>';
  out += bordersXml('tcBorders', props.borders, ['top', 'left', 'bottom', 'right']);
  if (props.background) out += `<w:shd w:val="clear" w:color="auto" w:fill="${hex(props.background)}"/>`;
  if (props.padding !== undefined) {
    const p = twips(props.padding);
    out += `<w:tcMar><w:top w:w="${p}" w:type="dxa"/><w:left w:w="${p}" w:type="dxa"/><w:bottom w:w="${p}" w:type="dxa"/><w:right w:w="${p}" w:type="dxa"/></w:tcMar>`;
  }
  if (props.vAlign) out += `<w:vAlign w:val="${VALIGN[props.vAlign]}"/>`;
  return `<w:tcPr>${out}</w:tcPr>`;
}

type Span = { kind: 'origin'; rows: number; cols: number } | { kind: 'below'; row: number; cols: number } | { kind: 'covered' };

/** What each grid position is: the top-left cell of a (merged) block, a row under one, or covered. */
function cellSpans(data: TableData): Span[][] {
  const grid: (Span | undefined)[][] = data.rows.map(() => data.cols.map(() => undefined));
  data.rows.forEach((r, ri) =>
    data.cols.forEach((c, ci) => {
      if (grid[ri]![ci]) return;
      const props = data.cells?.[`${r.id}:${c.id}`];
      const cols = freeCols(grid[ri]!, ci, Math.max(1, Math.min(props?.colSpan ?? 1, data.cols.length - ci)));
      const rows = Math.max(1, Math.min(props?.rowSpan ?? 1, data.rows.length - ri));
      grid[ri]![ci] = { kind: 'origin', rows, cols };
      coverSpan(grid, ri, ci, rows, cols);
    }),
  );
  return grid.map((row) => row.map((s) => s ?? { kind: 'covered' }));
}

/** How many of `cols` columns from `ci` a span gets: it stops at a position an earlier merge already took. */
function freeCols(row: (Span | undefined)[], ci: number, cols: number): number {
  for (let k = 1; k < cols; k++) if (row[ci + k]) return k;
  return cols;
}

/** Marks the positions a span starting at (`ri`, `ci`) covers that nothing has taken yet. */
function coverSpan(grid: (Span | undefined)[][], ri: number, ci: number, rows: number, cols: number): void {
  for (let dr = 0; dr < rows; dr++) {
    for (let dc = 0; dc < cols; dc++) {
      if (!dr && !dc) continue;
      const row = grid[ri + dr]!;
      if (row[ci + dc]) continue;
      row[ci + dc] = dc === 0 ? { kind: 'below', row: ri, cols } : { kind: 'covered' };
    }
  }
}

