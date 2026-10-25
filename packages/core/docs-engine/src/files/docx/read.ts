/**
 * Reading a .docx file (Office Open XML WordprocessingML) into a document
 * snapshot: the body, headers and footers per section, footnotes (endnotes
 * become footnotes), named styles, lists, sections and page setup, tables,
 * pictures, comments and tracked changes (as suggestions). What the engine
 * has no counterpart for is left out and named in `warnings`.
 *
 * The package is read through the shared ZIP layer, which inflates every part
 * against a byte budget, so a small file that expands without bound is
 * refused rather than read.
 */

import { child, childrenOf, openZip, parseXml, XmlError, ZipError, type XmlElement, type ZipLimits, type ZipReader } from '@weldsuite/zip-xml';
import { PARA } from '../../model/chars';
import type { StoryContent } from '../../model/content';
import { bulletList, checkList, numberedList } from '../../model/defaults';
import { DocModel, SNAPSHOT_VERSION, type DocSnapshot } from '../../model/document';
import {
  BODY,
  type Anchor,
  DEFAULT_SECTION,
  type DocComment,
  FINAL_SECTION,
  headerStoryId,
  type HeaderVariant,
  type SectionBreakObject,
  type SectionProps,
  type SectionStart,
  type TableData,
} from '../../model/objects';
import { newId } from '../../model/ids';
import { validateStoryContent } from '../../ops/validate';
import { REL, fromHex, fromTwips, mimeOf, num, onOff, readPageFmt, readSectionStart } from './convert';
import { StoryReader, type PartInfo, type ReadContext, type Rel } from './read-body';
import { readNumbering, readStyles, readTheme } from './read-format';
import { readCommentThreads } from './read-review';
import { DocxImportError, type DocxImage, type DocxImport, type DocxImportErrorCode, type DocxImportWarning, type ReadDocxOptions } from './types';

export async function readDocx(bytes: Uint8Array, options: ReadDocxOptions = {}): Promise<DocxImport> {
  const limits: ZipLimits = {};
  if (options.maxBytes) {
    limits.maxTotalSize = options.maxBytes;
    limits.maxEntrySize = options.maxBytes;
  }
  let zip: ZipReader;
  try {
    zip = openZip(bytes, limits);
  } catch (e) {
    throw importError(e);
  }
  try {
    return await readPackage(zip, options);
  } catch (e) {
    throw importError(e);
  }
}

function importError(e: unknown): DocxImportError {
  if (e instanceof DocxImportError) return e;
  if (e instanceof ZipError) {
    if (e.code === 'not_zip') return new DocxImportError('This file is not a Word document', 'not_docx');
    return new DocxImportError(e.message, zipErrorCode(e.code));
  }
  if (e instanceof XmlError) return new DocxImportError('The document is damaged', 'corrupt');
  throw e;
}

function zipErrorCode(code: ZipError['code']): DocxImportErrorCode {
  if (code === 'too_large') return 'too_large';
  return code === 'unsupported' ? 'unsupported' : 'corrupt';
}

/** The internal target of the first relationship of a type. */
function relTarget(rels: Map<string, Rel>, type: string): string | undefined {
  return [...rels.values()].find((r) => r.type === type && !r.external)?.target;
}

/** The footnotes or endnotes part the main part points at, with its notes by id. */
async function readNotes(zip: ZipReader, main: PartInfo, type: string, tag: string): Promise<ReadContext['footnotes']> {
  const path = relTarget(main.rels, type);
  const part = path ? await loadPart(zip, path) : null;
  if (!part) return null;
  const map = new Map<string, XmlElement>();
  for (const el of childrenOf(part.root, tag)) if (el.attrs.id !== undefined) map.set(el.attrs.id, el);
  return { part, notes: map };
}

/** The header and footer parts, by the relationship id sections refer to them with. */
async function readHeaderParts(zip: ZipReader, main: PartInfo): Promise<Map<string, PartInfo>> {
  const headerParts = new Map<string, PartInfo>();
  for (const [id, rel] of main.rels) {
    if (rel.external || (rel.type !== REL.header && rel.type !== REL.footer)) continue;
    const part = await loadPart(zip, rel.target);
    if (part) headerParts.set(id, part);
  }
  return headerParts;
}

function headerVariant(type: string | undefined): HeaderVariant {
  if (type === 'first') return 'first';
  return type === 'even' ? 'even' : 'default';
}

/** The bytes of the pictures the document uses, in the order they were met. */
async function readImages(zip: ZipReader, used: ReadContext['images']): Promise<DocxImage[]> {
  const images: DocxImage[] = [];
  for (const [path, entry] of used) {
    const data = await zip.read(path);
    if (data) images.push({ src: entry.src, bytes: data, mime: mimeOf(entry.name), name: entry.name });
  }
  return images;
}

/** Refuses a document whose stories the engine would not accept. */
function checkStories(stories: Record<string, StoryContent>): void {
  for (const [id, story] of Object.entries(stories)) {
    const err = validateStoryContent(story) ?? (story.text.endsWith(PARA) ? null : 'does not end with a paragraph mark');
    if (err) throw new DocxImportError(`The document could not be read (${id}: ${err})`, 'corrupt');
  }
}

async function readPackage(zip: ZipReader, options: ReadDocxOptions): Promise<DocxImport> {
  const makeId = options.makeId ?? (() => newId());
  const warnings = new Set<DocxImportWarning>();
  const rootRels = (await readRels(zip, '')) ?? new Map<string, Rel>();
  const mainPath = relTarget(rootRels, REL.officeDocument) ?? 'word/document.xml';
  const main = await loadPart(zip, mainPath);
  if (!main || main.root.name !== 'document') throw new DocxImportError('This file is not a Word document', 'not_docx');
  const body = child(main.root, 'body');
  if (!body) throw new DocxImportError('The document is damaged', 'corrupt');

  const theme = readTheme(await readTree(zip, relTarget(main.rels, REL.theme)));
  const sheet = readStyles(await readTree(zip, relTarget(main.rels, REL.styles)), theme);
  const numbering = readNumbering(await readTree(zip, relTarget(main.rels, REL.numbering)), theme);
  const settings = await readTree(zip, relTarget(main.rels, REL.settings));
  const headerParts = await readHeaderParts(zip, main);

  const evenAndOddEl = child(settings ?? undefined, 'evenAndOddHeaders');
  const evenAndOdd = !!evenAndOddEl && onOff(evenAndOddEl.attrs.val);
  const stories: Record<string, StoryContent> = {};
  const tables: Record<string, TableData> = {};
  const breaks: { obj: SectionBreakObject; type: SectionStart }[] = [];

  const ctx: ReadContext = {
    sheet,
    numbering,
    theme,
    warnings,
    makeId,
    stories,
    tables,
    images: new Map(),
    footnotes: await readNotes(zip, main, REL.footnotes, 'footnote'),
    endnotes: await readNotes(zip, main, REL.endnotes, 'endnote'),
    paragraphs: 0,
    anchors: [],
    revisions: new Map(),
    suggestionThreads: [],
    commentRanges: new Map(),
    sectionBreak(sectPr) {
      const obj: SectionBreakObject = { kind: 'sectionBreak', id: makeId(), start: 'nextPage', section: readSection(sectPr, evenAndOdd) };
      readHeaders(sectPr, obj.id);
      breaks.push({ obj, type: readSectionStart(child(sectPr, 'type')?.attrs.val) });
      return obj;
    },
  };

  /** Header and footer stories of one section, from its references. */
  function readHeaders(sectPr: XmlElement, sectionId: string): void {
    for (const ref of sectPr.children) {
      if (ref.name !== 'headerReference' && ref.name !== 'footerReference') continue;
      const part = ref.attrs.id ? headerParts.get(ref.attrs.id) : undefined;
      if (!part) continue;
      const storyId = headerStoryId(sectionId, ref.name === 'headerReference' ? 'header' : 'footer', headerVariant(ref.attrs.type));
      new StoryReader(ctx, part).readStory(storyId, part.root.children);
    }
  }

  const finalSectPr = [...body.children].reverse().find((c) => c.name === 'sectPr');
  new StoryReader(ctx, main, true).readStory(BODY, body.children.filter((c) => c !== finalSectPr));

  // Word keeps how a section starts on that section; the engine keeps it on the break before it.
  const finalType = readSectionStart(child(finalSectPr, 'type')?.attrs.val);
  breaks.forEach((b, i) => {
    b.obj.start = i + 1 < breaks.length ? breaks[i + 1]!.type : finalType;
  });
  const section = readSection(finalSectPr, evenAndOdd);
  const background = fromHex(child(main.root, 'background')?.attrs.color);
  if (background) section.background = background;
  if (finalSectPr) readHeaders(finalSectPr, FINAL_SECTION);

  const threads = readCommentThreads(
    await readTree(zip, relTarget(main.rels, REL.comments)),
    await readTree(zip, relTarget(main.rels, REL.commentsExtended)),
    ctx.commentRanges,
    stories,
    makeId,
  );
  if (threads.dropped) warnings.add('comments');
  const comments = [...usedSuggestions(ctx.suggestionThreads, stories), ...threads.comments];

  const images = await readImages(zip, ctx.images);

  const tab = fromTwips(child(settings ?? undefined, 'defaultTabStop')?.attrs.w ?? child(settings ?? undefined, 'defaultTabStop')?.attrs.val);
  const raw: DocSnapshot = {
    version: SNAPSHOT_VERSION,
    props: { section, ...(tab && tab !== 36 ? { tabInterval: tab } : {}) },
    styles: sheet.styles,
    lists: { bullet: bulletList(), numbered: numberedList(), check: checkList(), ...numbering.lists },
    stories,
    tables,
    anchors: uniqueAnchors([...ctx.anchors, ...threads.anchors]),
    ...(comments.length ? { comments } : {}),
  };
  checkStories(stories);
  const out: DocxImport = { snapshot: DocModel.fromSnapshot(raw).toSnapshot(), images, warnings: [...warnings].sort() };
  const title = await readTitle(zip, relTarget(rootRels, REL.coreProps));
  if (title) out.title = title;
  return out;
}

function readSection(sectPr: XmlElement | undefined, evenAndOdd: boolean): SectionProps {
  const s: SectionProps = { ...DEFAULT_SECTION };
  if (evenAndOdd) s.evenAndOdd = true;
  if (!sectPr) return s;
  const size = child(sectPr, 'pgSz')?.attrs;
  const w = fromTwips(size?.w);
  const h = fromTwips(size?.h);
  if (w && h) {
    s.pageWidth = w;
    s.pageHeight = h;
  }
  const mar = child(sectPr, 'pgMar')?.attrs;
  if (mar) {
    const m = (v: string | undefined) => {
      const n = fromTwips(v);
      return n === undefined ? undefined : Math.abs(n);
    };
    s.marginTop = m(mar.top) ?? s.marginTop;
    s.marginBottom = m(mar.bottom) ?? s.marginBottom;
    s.marginLeft = m(mar.left ?? mar.start) ?? s.marginLeft;
    s.marginRight = m(mar.right ?? mar.end) ?? s.marginRight;
    s.headerMargin = m(mar.header) ?? s.headerMargin;
    s.footerMargin = m(mar.footer) ?? s.footerMargin;
  }
  const cols = child(sectPr, 'cols')?.attrs;
  const count = num(cols?.num);
  if (count && count > 1) {
    s.columns = Math.min(count, 12);
    s.columnGap = fromTwips(cols?.space) ?? 36;
  }
  const titlePg = child(sectPr, 'titlePg');
  if (titlePg && onOff(titlePg.attrs.val)) s.titlePage = true;
  const pg = child(sectPr, 'pgNumType')?.attrs;
  const start = num(pg?.start);
  if (start !== undefined) s.pageNumberStart = start;
  const fmt = readPageFmt(pg?.fmt);
  if (fmt && fmt !== 'decimal') s.pageNumberFormat = fmt;
  return s;
}

async function readTree(zip: ZipReader, path: string | undefined): Promise<XmlElement | null> {
  if (!path) return null;
  const xml = await zip.readText(path);
  return xml === null ? null : parseXml(xml);
}

async function loadPart(zip: ZipReader, path: string): Promise<PartInfo | null> {
  const root = await readTree(zip, path);
  if (!root) return null;
  return { path, root, rels: (await readRels(zip, path)) ?? new Map() };
}

/** The relationships of the part at `path` ('' for the package's own), by id. */
async function readRels(zip: ZipReader, path: string): Promise<Map<string, Rel> | null> {
  const slash = path.lastIndexOf('/');
  const dir = slash < 0 ? '' : path.slice(0, slash + 1);
  const root = await readTree(zip, `${dir}_rels/${path.slice(slash + 1)}.rels`);
  if (!root) return null;
  const out = new Map<string, Rel>();
  for (const r of childrenOf(root, 'Relationship')) {
    const external = r.attrs.TargetMode === 'External';
    const target = r.attrs.Target ?? '';
    out.set(r.attrs.Id ?? '', { type: r.attrs.Type ?? '', target: external ? target : resolvePath(dir, target), external });
  }
  return out;
}

/** A relationship target, relative to the folder of the part that names it (or absolute with a leading '/'). */
function resolvePath(dir: string, target: string): string {
  const parts = (target.startsWith('/') ? target.slice(1) : dir + target).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part !== '.' && part !== '') out.push(part);
  }
  return out.join('/');
}

async function readTitle(zip: ZipReader, path: string | undefined): Promise<string | undefined> {
  const root = await readTree(zip, path ?? 'docProps/core.xml').catch(() => null);
  const title = child(root ?? undefined, 'title')?.text.trim();
  return title || undefined;
}

/** The threads of the suggestions that marked some text (a revision may have held nothing the engine keeps). */
function usedSuggestions(threads: DocComment[], stories: Record<string, StoryContent>): DocComment[] {
  const used = new Set<string>();
  for (const story of Object.values(stories)) {
    for (const [, style] of story.runs ?? []) if (style.suggestion) used.add(style.suggestion.id);
  }
  return threads.filter((t) => used.has(t.id));
}

/** One bookmark per name (Word's names are unique; a damaged file's may not be). */
function uniqueAnchors(anchors: Anchor[]): Anchor[] {
  const seen = new Set<string>();
  return anchors.filter((a) => !seen.has(a.id) && seen.add(a.id));
}
