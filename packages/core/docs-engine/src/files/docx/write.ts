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
 *   that would otherwise come last.
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
import { toBlocks, type Block, type BookmarkRange, type Inline, type ParagraphBlock, type TableBlock } from '../../serialize/blocks';
import { EMU_PER_POINT, NS, REL, hex, imageExtension, pageFmt, twips } from './convert';
import type { WriteDocxOptions } from './types';
import { bordersXml, numberingIds, numberingXml, pPrXml, rPrXml, stylesXml, wordStyleIds, type FormatContext } from './write-format';

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
  }

  write(title: string | undefined, date: Date): { name: string; data: Uint8Array | string }[] {
    const body = this.storyBlocks(BODY);
    let bodyXml = this.blocksXml(body, this.document, true);
    bodyXml += this.sectPr(this.sections[this.sections.length - 1]!);
    const background = this.snapshot.props.section.background;
    const documentXml = `${XML_HEADER}<w:document ${ROOT_NS}>${background ? `<w:background w:color="${hex(background)}"/>` : ''}<w:body>${bodyXml}</w:body></w:document>`;

    this.document.rel(REL.styles, 'styles.xml');
    this.document.rel(REL.numbering, 'numbering.xml');
    this.document.rel(REL.settings, 'settings.xml');
    if (this.footnotes.length) this.document.rel(REL.footnotes, 'footnotes.xml');

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
    return toBlocks({ ...story, ...this.all }, { story: storyId, bookmarks: (id) => this.bookmarks.get(id) ?? [] }).blocks;
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
    let out = '';
    let current: Inline[] = [];
    let emitted = false;
    const flush = (sectPr?: string) => {
      out += `<w:p>${pPrXml(block.props, this.ctx, { sectPr })}${emitted ? '' : lead}${this.runsXml(current, part)}</w:p>`;
      current = [];
      emitted = true;
    };
    for (const inline of block.inlines) {
      if (inline.type === 'object' && inline.data.kind === 'hr') {
        if (current.length) flush();
        const { list: _list, checked: _checked, borders: _borders, ...rest } = block.props;
        out += `<w:p>${pPrXml(rest, this.ctx, { borders: { bottom: DEFAULT_TABLE_BORDER } })}${emitted ? '' : lead}</w:p>`;
        emitted = true;
      } else if (inline.type === 'object' && inline.data.kind === 'sectionBreak') {
        if (sections && this.sectionIndex < this.sections.length - 1) flush(this.sectPr(this.sections[this.sectionIndex++]!));
      } else {
        current.push(inline);
      }
    }
    if (current.length || !emitted) flush();
    return out;
  }

  private runsXml(inlines: Inline[], part: Part): string {
    let out = '';
    let link: string | undefined;
    for (const inline of inlines) {
      const target = inline.style.link;
      if (target !== link) {
        if (link !== undefined) out += '</w:hyperlink>';
        link = undefined;
        const open = target ? this.hyperlinkOpen(target, part) : '';
        if (open) {
          out += open;
          link = target;
        }
      }
      out += this.inlineXml(inline, part);
    }
    if (link !== undefined) out += '</w:hyperlink>';
    return out;
  }

  private hyperlinkOpen(target: string, part: Part): string {
    if (target.startsWith('#')) return target.length > 1 ? `<w:hyperlink w:anchor="${esc(bookmarkName(target.slice(1)))}" w:history="1">` : '';
    if (!SAFE_LINK.test(target)) return '';
    return `<w:hyperlink r:id="${part.rel(REL.hyperlink, target, true)}" w:history="1">`;
  }

  private inlineXml(inline: Inline, part: Part): string {
    const rPr = rPrXml(inline.style);
    switch (inline.type) {
      case 'text':
        return textRun(rPr, inline.text);
      case 'tab':
        return `<w:r>${rPr}<w:tab/></w:r>`;
      case 'break':
        return `<w:r>${rPr}<w:br/></w:r>`;
      case 'object':
        return this.objectXml(inline.data, rPr, part);
      case 'bookmark':
        return this.bookmarkXml(inline.id, inline.edge);
    }
  }

  private bookmarkXml(id: string, edge: 'start' | 'end'): string {
    let n = this.bookmarkIds.get(id);
    if (n === undefined) this.bookmarkIds.set(id, (n = this.bookmarkIds.size));
    return edge === 'start' ? `<w:bookmarkStart w:id="${n}" w:name="${esc(bookmarkName(id))}"/>` : `<w:bookmarkEnd w:id="${n}"/>`;
  }

  private objectXml(data: ObjectData, rPr: string, part: Part): string {
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
        return `<w:fldSimple w:instr="${esc(instr)}">${textRun(rPr, shown)}</w:fldSimple>`;
      }
      case 'chip':
        return textRun(rPr, data.label);
      case 'equation':
        return textRun(rPr, data.latex);
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
    const inner =
      `<wp:docPr${attrs({ id, name: `Picture ${id}`, descr: img.alt || undefined })}/>` +
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
      out += `<w:tr>${trPr ? `<w:trPr>${trPr}</w:trPr>` : ''}`;
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
    entry.xml = `${XML_HEADER}<w:${tag} ${ROOT_NS}>${this.blocksXml(this.storyBlocks(storyId), part)}</w:${tag}>`;
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

function textRun(rPr: string, text: string): string {
  return `<w:r>${rPr}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
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
      let cols = Math.max(1, Math.min(props?.colSpan ?? 1, data.cols.length - ci));
      const rows = Math.max(1, Math.min(props?.rowSpan ?? 1, data.rows.length - ri));
      // A span stops at a position an earlier merge already took.
      for (let k = 1; k < cols; k++) {
        if (grid[ri]![ci + k]) {
          cols = k;
          break;
        }
      }
      grid[ri]![ci] = { kind: 'origin', rows, cols };
      for (let dr = 0; dr < rows; dr++) {
        for (let dc = 0; dc < cols; dc++) {
          if (!dr && !dc) continue;
          const row = grid[ri + dr]!;
          if (row[ci + dc]) continue;
          row[ci + dc] = dc === 0 ? { kind: 'below', row: ri, cols } : { kind: 'covered' };
        }
      }
    }),
  );
  return grid.map((row) => row.map((s) => s ?? { kind: 'covered' }));
}

