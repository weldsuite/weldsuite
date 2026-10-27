/**
 * Reading story content: the paragraphs, runs and tables of the body, a
 * header or footer, a footnote or a table cell, into engine content.
 *
 * Revisions become suggestions: inserted text (`w:ins`, `w:moveTo`) is
 * marked as a suggested insertion, deleted text (`w:del`, `w:moveFrom`) as a
 * suggested deletion, one suggestion per Word revision id, whose thread holds
 * the revision's author and date. Formatting changes are taken as accepted.
 * Comment ranges are noted by Word comment id, for `read-review.ts`.
 * Fields the engine has (page, page count, date, title) become field objects;
 * any other field keeps the text Word last showed for it. A table is its own
 * paragraph in the engine, so the empty paragraph Word needs after a table at
 * the end of a cell or the body is dropped again.
 */

import { child, childrenOf, type XmlElement } from '@weldsuite/zip-xml';
import { cleanStoryText, LINE_BREAK, PARA, TAB } from '../../model/chars';
import { ContentBuilder } from '../../model/builder';
import type { StoryContent } from '../../model/content';
import { NORMAL } from '../../model/defaults';
import {
  cellKey,
  cellStoryId,
  type Anchor,
  footnoteStoryId,
  type DocComment,
  type CellBorders,
  type CellProps,
  type FieldObject,
  type ImageObject,
  type ObjectData,
  type SectionBreakObject,
  type TableData,
  type TableProps,
} from '../../model/objects';
import { resolveParagraph } from '../../model/resolve';
import { isEmptyObject, type BorderLine, type ParaProps, type TextStyle } from '../../model/styles';
import { EMU_PER_POINT, fromHex, fromTwips, num, onOff, readBorder, readWordDate, round2 } from './convert';
import { readParaProps, readRunProps, relativeTabs, tableBorder, type Numbering, type ParaInfo, type StyleSheet, type Theme } from './read-format';
import { authorOf, type CommentRange } from './read-review';
import { DocxImportError, type DocxImportWarning } from './types';

type Suggestion = NonNullable<TextStyle['suggestion']>;

/** Paragraphs read at most (every story together); a file with more is refused. */
export const MAX_PARAGRAPHS = 200_000;
const SAFE_LINK = /^(https?:|mailto:|tel:)/i;
const DEFAULT_BORDER: BorderLine = { width: 0.75, color: '#000000' };
const DEFAULT_PADDING = 5;

export interface Rel {
  type: string;
  /** Package path for internal targets, the raw target for external ones. */
  target: string;
  external: boolean;
}

/** An XML part and its relationships (images and links resolve against the part they appear in). */
export interface PartInfo {
  path: string;
  root: XmlElement;
  rels: Map<string, Rel>;
}

export interface ReadContext {
  sheet: StyleSheet;
  numbering: Numbering;
  theme: Theme;
  warnings: Set<DocxImportWarning>;
  makeId: () => string;
  stories: Record<string, StoryContent>;
  tables: Record<string, TableData>;
  /** Pictures used, by package path. */
  images: Map<string, { name: string; src: string }>;
  footnotes: { part: PartInfo; notes: Map<string, XmlElement> } | null;
  endnotes: { part: PartInfo; notes: Map<string, XmlElement> } | null;
  /** Bookmarks read so far (their names are their ids, so links to them keep working). */
  anchors: Anchor[];
  /** Turns a paragraph's `w:sectPr` into the section-break object that ends that section. */
  sectionBreak(sectPr: XmlElement): SectionBreakObject;
  paragraphs: number;
  /** The suggestion id for each Word revision id met so far. */
  revisions: Map<string, string>;
  /** Each suggestion's thread entry: the revision's author and date. */
  suggestionThreads: DocComment[];
  /** Where each comment is, by Word comment id (the first place met). */
  commentRanges: Map<string, CommentRange>;
}

/** Word's revision elements: what they mark their content as. */
const REVISION_KIND = new Map<string, Suggestion['kind']>([
  ['ins', 'insert'],
  ['moveTo', 'insert'],
  ['del', 'delete'],
  ['moveFrom', 'delete'],
]);

/** The suggestion a Word revision marks its content with: one per Word revision id, its thread made when first met. */
function revisionSuggestion(ctx: ReadContext, el: XmlElement): Suggestion {
  const kind = REVISION_KIND.get(el.name) ?? 'insert';
  const word = el.attrs.id;
  const known = word === undefined ? undefined : ctx.revisions.get(word);
  if (known) return { id: known, kind };
  const id = ctx.makeId();
  if (word !== undefined) ctx.revisions.set(word, id);
  ctx.suggestionThreads.push({ id, author: authorOf(el.attrs.author), createdAt: readWordDate(el.attrs.date), suggestion: id });
  return { id, kind };
}

interface FieldFrame {
  instr: string;
  phase: 'code' | 'result';
  /** The field became an object: its shown result is skipped. */
  replaced: boolean;
  link?: string;
}

/** Run children that show something, and so are skipped inside a field code or a replaced field result. */
const RUN_CONTENT = new Set([
  't',
  'delText',
  'tab',
  'ptab',
  'br',
  'cr',
  'noBreakHyphen',
  'softHyphen',
  'sym',
  'pgNum',
  'drawing',
  'pict',
  'footnoteReference',
  'endnoteReference',
]);

const IGNORED_BLOCK = new Set(['pPr', 'rPr', 'bookmarkStart', 'bookmarkEnd', 'proofErr', 'permStart', 'permEnd', 'sectPr', 'tblPr', 'tblGrid']);

/** Bookmark names WeldDocs keeps (Word's own rules, less its hidden `_GoBack`). */
const BOOKMARK_NAME = /^[A-Za-z_]\w{0,39}$/;

export function isBookmarkName(name: string | undefined): name is string {
  return !!name && BOOKMARK_NAME.test(name) && name !== '_GoBack';
}

export class StoryReader {
  private readonly b: ContentBuilder;
  private readonly fields: FieldFrame[] = [];
  /** Set after a footnote's own number mark, so the space Word puts after it is not kept. */
  private afterNoteMark = false;
  /** Bookmarks started and not yet ended, by Word's id. */
  private readonly openMarks = new Map<string, { name: string; from: number }>();
  private readonly marks: { name: string; from: number; to: number }[] = [];
  /** The suggestion of the revision being read, if any. */
  private revision: Suggestion | undefined;
  /** Revisions around block-level elements (paragraphs or tables inside a `w:ins` / `w:del`). */
  private readonly blockRevisions = new Map<XmlElement, Suggestion>();
  /** Comment ranges started and not yet ended, and those read, by Word's id. */
  private readonly openComments = new Map<string, number>();
  private readonly comments = new Map<string, { from: number; to: number }>();

  constructor(
    private readonly ctx: ReadContext,
    private readonly part: PartInfo,
    private readonly sections = false,
  ) {
    this.b = new ContentBuilder(ctx.makeId);
  }

  /** Reads a story and keeps it, with its bookmarks and comment ranges, under `storyId`. */
  readStory(storyId: string, children: XmlElement[]): void {
    const content = this.read(children);
    this.ctx.stories[storyId] = content;
    const last = content.text.length - 1;
    for (const m of this.marks) {
      const from = Math.min(m.from, last);
      this.ctx.anchors.push({ id: m.name, kind: 'bookmark', story: storyId, from, to: Math.max(from, Math.min(m.to, last)) });
    }
    for (const [word, m] of this.comments) {
      const from = Math.min(m.from, last);
      if (!this.ctx.commentRanges.has(word)) this.ctx.commentRanges.set(word, { story: storyId, from, to: Math.max(from, Math.min(m.to, last)) });
    }
  }

  /** Reads block-level children (paragraphs, tables, content controls) into a story ending with a paragraph mark. */
  read(children: XmlElement[]): StoryContent {
    this.blocks(children);
    if (!this.b.atParagraphStart || this.b.length === 0) this.b.endParagraph();
    const { text, runs, paras, objects } = this.b.build();
    const out: StoryContent = { text };
    if (runs) out.runs = runs;
    if (paras) out.paras = paras;
    if (objects) out.objects = objects;
    return out;
  }

  // ---------------------------------------------------------------- blocks

  private blocks(children: XmlElement[]): void {
    const flat = this.flattenBlocks(children);
    flat.forEach((el, i) => {
      const outer = this.revision;
      this.revision = this.blockRevisions.get(el) ?? outer;
      this.block(el, i === flat.length - 1 && i > 0 && flat[i - 1]!.name === 'tbl');
      this.revision = outer;
    });
  }

  /** One block-level element; `afterLastTable` when it ends the story right after a table. */
  private block(el: XmlElement, afterLastTable: boolean): void {
    if (el.name === 'bookmarkStart' || el.name === 'bookmarkEnd') this.bookmark(el);
    else if (el.name === 'commentRangeStart' || el.name === 'commentRangeEnd') this.commentRange(el);
    else if (el.name === 'tbl') this.table(el);
    else if (el.name === 'oMathPara' || el.name === 'oMath') {
      this.ctx.warnings.add('equations');
      this.addText(mathText(el), {});
      this.endParagraph({});
    } else if (!afterLastTable || !isBareParagraph(el)) this.paragraph(el);
  }

  private flattenBlocks(children: XmlElement[]): XmlElement[] {
    const out: XmlElement[] = [];
    for (const el of children) {
      switch (el.name) {
        case 'p':
        case 'tbl':
        case 'bookmarkStart':
        case 'bookmarkEnd':
        case 'commentRangeStart':
        case 'commentRangeEnd':
          out.push(el);
          break;
        case 'sdt':
          out.push(...this.flattenBlocks(child(el, 'sdtContent')?.children ?? []));
          break;
        case 'customXml':
        case 'smartTag':
          out.push(...this.flattenBlocks(el.children));
          break;
        case 'ins':
        case 'moveTo':
        case 'del':
        case 'moveFrom': {
          // What a revision holds is marked with it, unless a revision inside it marks it first.
          const rev = revisionSuggestion(this.ctx, el);
          for (const inner of this.flattenBlocks(el.children)) {
            if (!this.blockRevisions.has(inner)) this.blockRevisions.set(inner, rev);
            out.push(inner);
          }
          break;
        }
        case 'altChunk':
          this.ctx.warnings.add('embeddedDocuments');
          break;
        case 'oMathPara':
        case 'oMath':
          out.push(el);
          break;
        default:
          break;
      }
    }
    return out;
  }

  private endParagraph(props: ParaProps, mark?: Suggestion): void {
    if (++this.ctx.paragraphs > MAX_PARAGRAPHS) throw new DocxImportError('The document has too many paragraphs to open', 'too_large');
    this.b.endParagraph(props, mark ? { suggestion: mark } : {});
  }

  private paragraph(p: XmlElement): void {
    const pPr = child(p, 'pPr');
    if (child(pPr, 'pPrChange')) this.ctx.warnings.add('trackedChanges');
    const info = readParaProps(pPr);
    const props = info.props;
    const styleId = info.styleId ? this.ctx.sheet.paraIds.get(info.styleId) : undefined;
    if (styleId && styleId !== NORMAL) props.style = styleId;
    this.applyList(props, info.numPr ?? (styleId ? this.ctx.sheet.styleLists.get(styleId) : undefined));
    const start = this.b.length;
    this.inlines(p.children, undefined);
    if (this.b.length === start && isRuleBorder(props)) {
      // An empty paragraph with only a bottom border is how Word draws a horizontal rule.
      delete props.borders;
      this.b.addObject({ kind: 'hr' });
    }
    if (info.sectPr && this.sections) this.b.addObject(this.ctx.sectionBreak(info.sectPr));
    if (info.tabs) {
      const tabs = relativeTabs(info.tabs, this.tabBase(props));
      if (tabs.length) props.tabs = tabs;
    }
    // A paragraph mark Word marks inserted or deleted is a suggested paragraph break.
    const markRev = child(pPr, 'rPr')?.children.find((c) => REVISION_KIND.has(c.name));
    this.endParagraph(props, markRev ? revisionSuggestion(this.ctx, markRev) : this.revision);
  }

  /** Puts the paragraph in the list its numbering (own or from its style) points at, when that list exists. */
  private applyList(props: ParaProps, numPr: ParaInfo['numPr']): void {
    if (!numPr || numPr.numId === '0') return;
    const n = this.ctx.numbering.nums.get(numPr.numId);
    if (!n) return;
    props.list = { id: n.listId, level: numPr.level };
    if (n.checked) props.checked = true;
  }

  private tabBase(props: ParaProps): number {
    if (props.list) {
      const level = this.ctx.numbering.lists[props.list.id]?.levels[props.list.level];
      if (level) return level.indent;
    }
    return resolveParagraph({ styles: this.ctx.sheet.styles }, props).indentLeft ?? 0;
  }

  // ---------------------------------------------------------------- inlines

  private inlines(children: XmlElement[], link: string | undefined): void {
    for (const el of children) {
      switch (el.name) {
        case 'r':
          this.run(el, link);
          break;
        case 'hyperlink':
          this.inlines(el.children, this.hyperlink(el) ?? link);
          break;
        case 'fldSimple':
          this.simpleField(el, link);
          break;
        case 'ins':
        case 'moveTo':
        case 'del':
        case 'moveFrom': {
          const outer = this.revision;
          this.revision = revisionSuggestion(this.ctx, el);
          this.inlines(el.children, link);
          this.revision = outer;
          break;
        }
        case 'smartTag':
        case 'customXml':
        case 'dir':
        case 'bdo':
          this.inlines(el.children, link);
          break;
        case 'sdt':
          this.inlines(child(el, 'sdtContent')?.children ?? [], link);
          break;
        case 'oMath':
        case 'oMathPara':
          this.ctx.warnings.add('equations');
          this.addText(mathText(el), {});
          break;
        case 'commentRangeStart':
        case 'commentRangeEnd':
          this.commentRange(el);
          break;
        case 'bookmarkStart':
        case 'bookmarkEnd':
          this.bookmark(el);
          break;
        case 'AlternateContent':
          this.inlines(alternative(el), link);
          break;
        default:
          break;
      }
    }
  }

  private hyperlink(el: XmlElement): string | undefined {
    const anchor = el.attrs.anchor;
    const rel = el.attrs.id ? this.part.rels.get(el.attrs.id) : undefined;
    if (rel?.external && SAFE_LINK.test(rel.target)) return anchor ? `${rel.target}#${anchor}` : rel.target;
    if (anchor) return `#${anchor}`;
    return undefined;
  }

  private runStyle(rPr: XmlElement | undefined, link: string | undefined): TextStyle {
    if (child(rPr, 'rPrChange')) this.ctx.warnings.add('trackedChanges');
    const charStyle = rPr ? this.ctx.sheet.charStyles.get(child(rPr, 'rStyle')?.attrs.val ?? '') : undefined;
    const style: TextStyle = { ...charStyle, ...readRunProps(rPr, this.ctx.theme) };
    const target = this.fieldLink() ?? link;
    if (target) style.link = target;
    return style;
  }

  private run(r: XmlElement, link: string | undefined): void {
    const style = this.runStyle(child(r, 'rPr'), link);
    this.runChildren(r.children, style);
  }

  private runChildren(children: XmlElement[], style: TextStyle): void {
    for (const el of children) {
      if (!RUN_CONTENT.has(el.name)) this.runControl(el, style);
      else if (!this.suppressed()) this.runContent(el, style);
    }
  }

  /** A run child that shows something (text, a break, a picture, a note mark); skipped while `suppressed()`. */
  private runContent(el: XmlElement, style: TextStyle): void {
    switch (el.name) {
      case 't':
      case 'delText':
        this.addText(el.text, style);
        break;
      case 'tab':
      case 'ptab':
        this.addRaw(TAB, style);
        break;
      case 'br':
        this.lineBreak(el.attrs.type, style);
        break;
      case 'cr':
        this.addRaw(LINE_BREAK, style);
        break;
      case 'noBreakHyphen':
        this.addText('‑', style);
        break;
      case 'softHyphen':
        this.addText('­', style);
        break;
      case 'sym':
        this.symbol(el.attrs.char, style);
        break;
      case 'pgNum':
        this.addObject({ kind: 'field', field: 'page' }, style);
        break;
      case 'drawing':
        this.drawing(el, style);
        break;
      case 'pict':
        this.pict(el, style);
        break;
      case 'footnoteReference':
        this.note(el.attrs.id, false);
        break;
      case 'endnoteReference':
        this.note(el.attrs.id, true);
        break;
      default:
        break;
    }
  }

  private lineBreak(type: string | undefined, style: TextStyle): void {
    if (type === 'page') this.addObject({ kind: 'pageBreak' }, {});
    else if (type === 'column') this.addObject({ kind: 'columnBreak' }, {});
    else this.addRaw(LINE_BREAK, style);
  }

  /** A `w:sym` character; private-use code points (symbol-font glyphs) are dropped. */
  private symbol(char: string | undefined, style: TextStyle): void {
    const code = Number.parseInt(char ?? '', 16);
    if (Number.isFinite(code) && !(code >= 0xe000 && code <= 0xf8ff)) this.addText(String.fromCodePoint(code), style);
  }

  /** The other run children: field codes, note marks, and what only warns or wraps. */
  private runControl(el: XmlElement, style: TextStyle): void {
    switch (el.name) {
      case 'instrText':
      case 'delInstrText': {
        const top = this.fields[this.fields.length - 1];
        if (top?.phase === 'code') top.instr += el.text;
        break;
      }
      case 'fldChar':
        this.fieldChar(el.attrs.fldCharType, style);
        break;
      case 'object':
        this.ctx.warnings.add('embeddedObjects');
        break;
      case 'footnoteRef':
      case 'endnoteRef':
        this.afterNoteMark = true;
        break;
      case 'commentReference':
        this.commentReference(el.attrs.id);
        break;
      case 'AlternateContent':
        this.runChildren(alternative(el), style);
        break;
      case 'ruby':
        this.inlines(child(el, 'rubyBase')?.children ?? [], style.link);
        break;
      default:
        break;
    }
  }

  private bookmark(el: XmlElement): void {
    const id = el.attrs.id;
    if (id === undefined) return;
    if (el.name === 'bookmarkStart') {
      if (isBookmarkName(el.attrs.name)) this.openMarks.set(id, { name: el.attrs.name, from: this.b.length });
      return;
    }
    const open = this.openMarks.get(id);
    if (!open) return;
    this.openMarks.delete(id);
    this.marks.push({ ...open, to: this.b.length });
  }

  private commentRange(el: XmlElement): void {
    const id = el.attrs.id;
    if (id === undefined) return;
    if (el.name === 'commentRangeStart') {
      if (!this.comments.has(id)) this.openComments.set(id, this.b.length);
      return;
    }
    const from = this.openComments.get(id);
    if (from === undefined) return;
    this.openComments.delete(id);
    this.comments.set(id, { from, to: this.b.length });
  }

  /** A comment's mark: it ends a range left open, or is the comment's place when it has no range. */
  private commentReference(id: string | undefined): void {
    if (id === undefined || this.comments.has(id)) return;
    const from = this.openComments.get(id) ?? this.b.length;
    this.openComments.delete(id);
    this.comments.set(id, { from, to: this.b.length });
  }

  private addText(raw: string, style: TextStyle): void {
    let text = cleanStoryText(raw.replace(/[\r\n]/g, ' '));
    if (this.afterNoteMark && text) {
      text = text.replace(/^ /, '');
      this.afterNoteMark = false;
    }
    if (text) this.b.addText(text, this.marked(style));
  }

  private addRaw(ch: string, style: TextStyle): void {
    this.afterNoteMark = false;
    this.b.addText(ch, this.marked(style));
  }

  private addObject(data: ObjectData, style: TextStyle): void {
    this.afterNoteMark = false;
    this.b.addObject(data, this.marked(style));
  }

  /** The style text is added with: as read, marked with the revision being read. */
  private marked(style: TextStyle): TextStyle {
    const out = tidy(style);
    if (this.revision) out.suggestion = { ...this.revision };
    return out;
  }

  // ---------------------------------------------------------------- fields

  /** True while reading a field's code, or the shown result of a field that became an object. */
  private suppressed(from = this.fields.length): boolean {
    for (let i = 0; i < from; i++) {
      const f = this.fields[i]!;
      if (f.phase === 'code' || f.replaced) return true;
    }
    return false;
  }

  private fieldLink(): string | undefined {
    for (let i = this.fields.length - 1; i >= 0; i--) {
      const f = this.fields[i]!;
      if (f.phase === 'result' && f.link) return f.link;
    }
    return undefined;
  }

  private fieldChar(type: string | undefined, style: TextStyle): void {
    if (type === 'begin') {
      this.fields.push({ instr: '', phase: 'code', replaced: false });
    } else if (type === 'separate') {
      const top = this.fields[this.fields.length - 1];
      if (!top || top.phase !== 'code') return;
      top.phase = 'result';
      this.resolveField(top, style);
    } else if (type === 'end') {
      const top = this.fields[this.fields.length - 1];
      if (!top) return;
      if (top.phase === 'code') {
        top.phase = 'result';
        this.resolveField(top, style);
      }
      this.fields.pop();
    }
  }

  /** Turns a field whose code is complete into an object or a link, or leaves its result as text. */
  private resolveField(frame: FieldFrame, style: TextStyle): void {
    const parsed = parseField(frame.instr);
    if (parsed.kind === 'object') {
      frame.replaced = true;
      if (!this.suppressed(this.fields.length - 1)) this.addObject(parsed.data, style);
    } else if (parsed.kind === 'link') {
      frame.link = parsed.link;
    } else if (parsed.kind === 'other') {
      this.ctx.warnings.add('fields');
    }
  }

  private simpleField(el: XmlElement, link: string | undefined): void {
    const parsed = parseField(el.attrs.instr ?? '');
    if (parsed.kind === 'object') {
      const firstRun = child(el, 'r');
      if (!this.suppressed()) this.addObject(parsed.data, this.runStyle(child(firstRun, 'rPr'), link));
      return;
    }
    if (parsed.kind === 'other') this.ctx.warnings.add('fields');
    this.inlines(el.children, parsed.kind === 'link' ? parsed.link : link);
  }

  // ---------------------------------------------------------------- notes

  private note(id: string | undefined, endnote: boolean): void {
    const source = endnote ? this.ctx.endnotes : this.ctx.footnotes;
    const el = id === undefined ? undefined : source?.notes.get(id);
    if (!source || !el || el.attrs.type === 'separator' || el.attrs.type === 'continuationSeparator') return;
    if (endnote) this.ctx.warnings.add('endnotes');
    const noteId = this.ctx.makeId();
    new StoryReader(this.ctx, source.part).readStory(footnoteStoryId(noteId), el.children);
    this.addObject({ kind: 'footnote', id: noteId }, {});
  }

  // ---------------------------------------------------------------- pictures

  private drawing(el: XmlElement, style: TextStyle): void {
    const holder = child(el, 'inline') ?? child(el, 'anchor');
    if (!holder) return;
    const data = child(child(holder, 'graphic'), 'graphicData');
    const uri = data?.attrs.uri ?? '';
    if (!uri.endsWith('/picture')) {
      if (uri.includes('chart')) this.ctx.warnings.add('charts');
      else if (uri.includes('diagram')) this.ctx.warnings.add('smartArt');
      else this.ctx.warnings.add('textBoxes');
      return;
    }
    const pic = child(data, 'pic');
    const fill = child(pic, 'blipFill');
    const embed = child(fill, 'blip')?.attrs.embed;
    const extent = child(holder, 'extent')?.attrs;
    const docPr = child(holder, 'docPr')?.attrs;
    const width = round2((num(extent?.cx) ?? 0) / EMU_PER_POINT);
    const height = round2((num(extent?.cy) ?? 0) / EMU_PER_POINT);
    const img = this.image(embed, width, height, docPr?.descr || docPr?.title);
    if (!img) return;
    const rect = child(fill, 'srcRect')?.attrs;
    if (rect && (rect.l || rect.t || rect.r || rect.b)) {
      const f = (v: string | undefined) => Math.min(1, Math.max(0, (num(v) ?? 0) / 100_000));
      img.crop = { top: f(rect.t), right: f(rect.r), bottom: f(rect.b), left: f(rect.l) };
    }
    if (holder.name === 'anchor') Object.assign(img, anchorPlacement(holder));
    this.addObject(img, style);
  }

  /** A legacy VML picture (`w:pict`), or a VML horizontal rule. */
  private pict(el: XmlElement, style: TextStyle): void {
    const shape = el.children.find((c) => c.name === 'shape' || c.name === 'rect' || c.name === 'line' || c.name === 'group');
    if (!shape) return;
    if (shape.attrs.hr === 't' || shape.attrs.hr === 'true') {
      this.addObject({ kind: 'hr' }, {});
      return;
    }
    if (findDescendant(shape, 'textbox')) {
      this.ctx.warnings.add('textBoxes');
      return;
    }
    const data = findDescendant(shape, 'imagedata');
    if (!data) return;
    const css = parseVmlStyle(shape.attrs.style ?? '');
    if (/absolute/.test(shape.attrs.style ?? '')) this.ctx.warnings.add('floatingImages');
    const img = this.image(data.attrs.id, css.width ?? 72, css.height ?? 72, data.attrs.title || shape.attrs.alt);
    if (img) this.addObject(img, style);
  }

  private image(relId: string | undefined, width: number, height: number, alt: string | undefined): ImageObject | null {
    const rel = relId ? this.part.rels.get(relId) : undefined;
    if (!rel || rel.external || !isPositive(width) || !isPositive(height)) return null;
    let entry = this.ctx.images.get(rel.target);
    if (!entry) {
      const base = rel.target.slice(rel.target.lastIndexOf('/') + 1) || 'image';
      let name = base;
      const used = new Set([...this.ctx.images.values()].map((e) => e.name));
      let n = 2;
      while (used.has(name)) {
        name = `${n}-${base}`;
        n++;
      }
      entry = { name, src: `docx-image:${name}` };
      this.ctx.images.set(rel.target, entry);
    }
    const img: ImageObject = { kind: 'image', id: this.ctx.makeId(), src: entry.src, width, height };
    if (alt) img.alt = alt;
    return img;
  }

  // ---------------------------------------------------------------- tables

  private table(tbl: XmlElement): void {
    const ctx = this.ctx;
    const tblPr = child(tbl, 'tblPr');
    const grid = childrenOf(child(tbl, 'tblGrid'), 'gridCol').map((c) => fromTwips(c.attrs.w) ?? 0);

    const rows: RowInfo[] = [];
    let width = grid.length;
    for (const tr of rowsOf(tbl)) {
      const { row, end } = readRow(tr);
      width = Math.max(width, end);
      rows.push(row);
    }
    if (rows.length === 0) return;
    width = Math.max(1, width);

    const widths = columnWidths(grid, rows, width);
    const tableId = ctx.makeId();
    const data: TableData = {
      rows: rows.map((r) => rowData(r.el, ctx.makeId())),
      cols: widths.map((w) => ({ id: ctx.makeId(), width: w })),
    };
    const cells = this.tableCells(tableId, data, mergeOrigins(rows, width), width);
    for (const r of data.rows) {
      for (const c of data.cols) {
        const sid = cellStoryId(tableId, r.id, c.id);
        ctx.stories[sid] ??= { text: PARA };
      }
    }
    if (Object.keys(cells).length) data.cells = cells;
    const props = this.tableProps(tblPr);
    if (!isEmptyObject(props)) data.props = props;
    ctx.tables[tableId] = data;
    this.b.addObject({ kind: 'table', id: tableId });
    this.endParagraph({});
  }

  /** Reads each cell's story and returns the cell properties worth keeping, by cell key. */
  private tableCells(tableId: string, data: TableData, origin: Map<CellInfo, CellOrigin>, width: number): Record<string, CellProps> {
    const cells: Record<string, CellProps> = {};
    for (const [c, o] of origin) {
      if (c.col >= width) continue;
      const rowId = data.rows[o.row]!.id;
      const colId = data.cols[c.col]!.id;
      new StoryReader(this.ctx, this.part).readStory(cellStoryId(tableId, rowId, colId), c.el.children);
      const props: CellProps = { ...c.props };
      const span = Math.min(c.span, width - c.col);
      if (span > 1) props.colSpan = span;
      if (o.rowSpan > 1) props.rowSpan = o.rowSpan;
      if (!isEmptyObject(props)) cells[cellKey(rowId, colId)] = props;
    }
    return cells;
  }

  private tableProps(tblPr: XmlElement | undefined): TableProps {
    const props: TableProps = {};
    const jc = child(tblPr, 'jc')?.attrs.val;
    if (jc === 'center') props.align = 'center';
    else if (jc === 'right' || jc === 'end') props.align = 'right';
    const ind = fromTwips(child(tblPr, 'tblInd')?.attrs.w);
    if (ind) props.indent = ind;
    const styleId = child(tblPr, 'tblStyle')?.attrs.val;
    const border = tableBorder(child(tblPr, 'tblBorders')) ?? (styleId ? this.ctx.sheet.tableBorders.get(styleId) : undefined);
    // No border anywhere is a borderless table in Word; the engine draws a thin one unless told otherwise.
    const line = border ?? { width: 0, color: '#000000' };
    if (!sameBorder(line, DEFAULT_BORDER)) props.border = line;
    const pad = fromTwips(child(child(tblPr, 'tblCellMar'), 'left')?.attrs.w) ?? (styleId ? this.ctx.sheet.tablePadding.get(styleId) : undefined);
    if (pad !== undefined && pad !== DEFAULT_PADDING) props.padding = pad;
    return props;
  }
}

// ---------------------------------------------------------------- helpers

/** False for zero, negative numbers and NaN. */
function isPositive(n: number): boolean {
  return n > 0;
}

/** An empty paragraph's borders that are only a bottom line (and no list): Word's horizontal rule. */
function isRuleBorder(props: ParaProps): boolean {
  const b = props.borders;
  return !!b?.bottom && !b.top && !b.left && !b.right && !props.list;
}

function tidy(style: TextStyle): TextStyle {
  const out: TextStyle = {};
  for (const [k, v] of Object.entries(style)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

function flagOf(el: XmlElement | undefined): boolean {
  return !!el && onOff(el.attrs.val);
}

function sameBorder(a: BorderLine, b: BorderLine): boolean {
  return a.width === b.width && a.color === b.color && (a.style ?? 'solid') === (b.style ?? 'solid');
}

/** A paragraph with nothing in it (no runs, no section end): the one Word puts after a final table. */
function isBareParagraph(p: XmlElement): boolean {
  if (child(child(p, 'pPr'), 'sectPr')) return false;
  return p.children.every((c) => IGNORED_BLOCK.has(c.name));
}

/** A table cell as written, placed on its grid column. */
interface CellInfo {
  el: XmlElement;
  col: number;
  span: number;
  vMerge?: 'restart' | 'continue';
  props: CellProps;
  width?: number;
}

interface RowInfo {
  el: XmlElement;
  cells: CellInfo[];
}

/** Where a cell starts (its row) and how many rows it spans after vertical merges. */
interface CellOrigin {
  row: number;
  rowSpan: number;
}

/** A row's cells on the grid (horizontal merges joined); `end` is the grid width the row needs. */
function readRow(tr: XmlElement): { row: RowInfo; end: number } {
  const trPr = child(tr, 'trPr');
  let col = num(child(trPr, 'gridBefore')?.attrs.val) ?? 0;
  const cells: CellInfo[] = [];
  for (const tc of cellsOf(tr)) {
    const tcPr = child(tc, 'tcPr');
    const span = Math.max(1, num(child(tcPr, 'gridSpan')?.attrs.val) ?? 1);
    const hMerge = child(tcPr, 'hMerge');
    const prev = cells[cells.length - 1];
    if (hMerge && hMerge.attrs.val !== 'restart' && prev) prev.span += span;
    else cells.push(readCell(tc, tcPr, col, span));
    col += span;
  }
  return { row: { el: tr, cells }, end: col + (num(child(trPr, 'gridAfter')?.attrs.val) ?? 0) };
}

function readCell(tc: XmlElement, tcPr: XmlElement | undefined, col: number, span: number): CellInfo {
  const vm = child(tcPr, 'vMerge');
  const info: CellInfo = { el: tc, col, span, props: readCellProps(tcPr) };
  if (vm) info.vMerge = vm.attrs.val === 'restart' ? 'restart' : 'continue';
  const w = child(tcPr, 'tcW')?.attrs;
  if (w && (w.type === 'dxa' || w.type === undefined)) info.width = fromTwips(w.w);
  return info;
}

/** Column widths from the grid, else from single-column cells, else shared out evenly. */
function columnWidths(grid: number[], rows: RowInfo[], width: number): number[] {
  const widths: number[] = Array.from({ length: width }, (_, i) => grid[i] ?? 0);
  for (const r of rows) for (const c of r.cells) if (c.span === 1 && c.width && !widths[c.col]) widths[c.col] = c.width;
  const known = widths.filter((w) => w > 0);
  const fallback = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 451 / width;
  return widths.map((w) => round2(w > 0 ? w : fallback));
}

function rowData(tr: XmlElement, id: string): TableData['rows'][number] {
  const trPr = child(tr, 'trPr');
  const row: TableData['rows'][number] = { id };
  const height = fromTwips(child(trPr, 'trHeight')?.attrs.val);
  if (height) row.height = height;
  if (flagOf(child(trPr, 'tblHeader'))) row.header = true;
  if (flagOf(child(trPr, 'cantSplit'))) row.cantSplit = true;
  return row;
}

/** The cells that start a grid area, in reading order, with the rows a vertical merge adds to them. */
function mergeOrigins(rows: RowInfo[], width: number): Map<CellInfo, CellOrigin> {
  // The cell each grid position belongs to, for following vertical merges down.
  const owner: (CellInfo | undefined)[][] = rows.map(() => Array.from({ length: width }, () => undefined));
  const origin = new Map<CellInfo, CellOrigin>();
  const claim = (ri: number, c: CellInfo, by: CellInfo): void => {
    for (let k = 0; k < c.span && c.col + k < width; k++) owner[ri]![c.col + k] = by;
  };
  rows.forEach((r, ri) => {
    for (const c of r.cells) {
      const above = ri > 0 ? owner[ri - 1]![c.col] : undefined;
      if (c.vMerge === 'continue' && above && above.col === c.col) {
        origin.get(above)!.rowSpan++;
        claim(ri, c, above);
      } else {
        origin.set(c, { row: ri, rowSpan: 1 });
        claim(ri, c, c);
      }
    }
  });
  return origin;
}

function readCellProps(tcPr: XmlElement | undefined): CellProps {
  const props: CellProps = {};
  if (!tcPr) return props;
  const fill = fromHex(child(tcPr, 'shd')?.attrs.fill);
  if (fill) props.background = fill;
  const v = child(tcPr, 'vAlign')?.attrs.val;
  if (v === 'center') props.vAlign = 'middle';
  else if (v === 'bottom') props.vAlign = 'bottom';
  else if (v === 'top') props.vAlign = 'top';
  const bEl = child(tcPr, 'tcBorders');
  if (bEl) {
    const borders: CellBorders = {};
    const side = (key: keyof CellBorders, ...names: string[]) => {
      for (const n of names) {
        const line = readBorder(child(bEl, n)?.attrs);
        if (line) {
          borders[key] = line;
          return;
        }
      }
    };
    side('top', 'top');
    side('bottom', 'bottom');
    side('left', 'left', 'start');
    side('right', 'right', 'end');
    if (!isEmptyObject(borders)) props.borders = borders;
  }
  const pad = fromTwips(child(child(tcPr, 'tcMar'), 'left')?.attrs.w ?? child(child(tcPr, 'tcMar'), 'start')?.attrs.w);
  if (pad !== undefined) props.padding = pad;
  return props;
}

/** Rows of a table, including those wrapped in content controls or custom XML. */
function rowsOf(tbl: XmlElement): XmlElement[] {
  return unwrap(tbl.children, 'tr');
}

function cellsOf(tr: XmlElement): XmlElement[] {
  return unwrap(tr.children, 'tc');
}

function unwrap(children: XmlElement[], name: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const c of children) {
    if (c.name === name) out.push(c);
    else if (c.name === 'sdt') out.push(...unwrap(child(c, 'sdtContent')?.children ?? [], name));
    else if (c.name === 'customXml' || c.name === 'ins') out.push(...unwrap(c.children, name));
  }
  return out;
}

/** The children of `mc:AlternateContent` to read: the first choice (Word's own), else the fallback. */
function alternative(el: XmlElement): XmlElement[] {
  return (child(el, 'Choice') ?? child(el, 'Fallback'))?.children ?? [];
}

function findDescendant(el: XmlElement, name: string): XmlElement | undefined {
  for (const c of el.children) {
    if (c.name === name) return c;
    const found = findDescendant(c, name);
    if (found) return found;
  }
  return undefined;
}

/** Far enough right that layout puts the image at the right edge of its column. */
const RIGHT_EDGE = 10_000;

/**
 * How a picture placed on the page (`wp:anchor`) floats: its text wrapping,
 * and its offset from the paragraph. Offsets from the page or the margin are
 * kept as they are (layout keeps the picture inside its column).
 */
function anchorPlacement(anchor: XmlElement): Pick<ImageObject, 'wrap' | 'offsetX' | 'offsetY'> {
  const wrapEl = anchor.children.find((c) => c.name.startsWith('wrap'));
  let wrap: ImageObject['wrap'] = 'square';
  if (wrapEl?.name === 'wrapTopAndBottom') wrap = 'topBottom';
  else if (wrapEl?.name === 'wrapNone') wrap = onOff(anchor.attrs.behindDoc) ? 'behind' : 'front';
  const out: Pick<ImageObject, 'wrap' | 'offsetX' | 'offsetY'> = { wrap };
  const x = anchorOffset(child(anchor, 'positionH'), ['right', 'outside']);
  const y = anchorOffset(child(anchor, 'positionV'), []);
  if (x) out.offsetX = x;
  if (y) out.offsetY = y;
  return out;
}

function anchorOffset(pos: XmlElement | undefined, farValues: string[]): number {
  if (!pos) return 0;
  const offset = num(child(pos, 'posOffset')?.text);
  if (offset !== undefined) return Math.max(0, round2(offset / EMU_PER_POINT));
  return farValues.includes(child(pos, 'align')?.text ?? '') ? RIGHT_EDGE : 0;
}

/** Text of an Office Math element (its `m:t` runs). */
function mathText(el: XmlElement): string {
  if (el.name === 't') return el.text;
  return el.children.map(mathText).join('');
}

/** Points per unit of a VML length (no unit is points). */
const VML_UNITS: Record<string, number> = { pt: 1, px: 0.75, in: 72, cm: 72 / 2.54, mm: 72 / 25.4 };

function parseVmlStyle(style: string): { width?: number; height?: number } {
  const out: { width?: number; height?: number } = {};
  for (const part of style.split(';')) {
    const [k, v] = part.split(':').map((s) => s.trim());
    if ((k === 'width' || k === 'height') && v) {
      const length = vmlLength(v);
      if (length !== undefined) out[k] = length;
    }
  }
  return out;
}

/** A VML length in points; undefined when it is not a plain number with a known unit. */
function vmlLength(v: string): number | undefined {
  const m = /^([\d.]+)(pt|px|in|cm|mm)?$/.exec(v);
  if (!m) return undefined;
  return round2(Number(m[1]) * VML_UNITS[m[2] ?? 'pt']!);
}

type ParsedField = { kind: 'object'; data: FieldObject } | { kind: 'link'; link: string } | { kind: 'other' } | { kind: 'none' };

/** What a field code means to the engine: one of its fields, a link, or something else (whose result stays as text). */
export function parseField(instr: string): ParsedField {
  const code = instr.trim();
  if (!code) return { kind: 'none' };
  const name = code.split(/\s+/, 1)[0]!.toUpperCase();
  switch (name) {
    case 'PAGE':
      return { kind: 'object', data: { kind: 'field', field: 'page' } };
    case 'NUMPAGES':
    case 'SECTIONPAGES':
      return { kind: 'object', data: { kind: 'field', field: 'pages' } };
    case 'TITLE':
      return { kind: 'object', data: { kind: 'field', field: 'title' } };
    case 'DATE': {
      const m = /\\@\s*"([^"]*)"/.exec(code) ?? /\\@\s*(\S+)/.exec(code);
      const data: FieldObject = { kind: 'field', field: 'date' };
      if (m?.[1]) data.format = m[1];
      return { kind: 'object', data };
    }
    case 'PAGEREF': {
      const ref = code.split(/\s+/)[1];
      return isBookmarkName(ref) ? { kind: 'object', data: { kind: 'field', field: 'pageRef', ref } } : { kind: 'other' };
    }
    case 'HYPERLINK': {
      const anchor = /\\l\s+"([^"]*)"/.exec(code)?.[1];
      const url = /^HYPERLINK\s+"([^"]*)"/i.exec(code)?.[1] ?? /^HYPERLINK\s+([^\s\\"]+)/i.exec(code)?.[1];
      if (url && SAFE_LINK.test(url)) return { kind: 'link', link: anchor ? `${url}#${anchor}` : url };
      if (anchor) return { kind: 'link', link: `#${anchor}` };
      return { kind: 'none' };
    }
    default:
      return { kind: 'other' };
  }
}
