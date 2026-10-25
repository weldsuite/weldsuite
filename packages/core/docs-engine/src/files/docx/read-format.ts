/**
 * Formatting in: run and paragraph properties, the styles part (named
 * styles, document defaults, character and table styles), the numbering
 * part (list definitions) and the theme's fonts.
 *
 * The engine has paragraph styles only. Word's character styles are folded
 * into the runs that use them, and its document defaults into `normal`, so a
 * document looks the same without the engine knowing about either.
 */

import { child, childrenOf, type XmlElement } from '@weldsuite/zip-xml';
import { BUILT_IN_STYLES, NORMAL, bulletList, numberedList } from '../../model/defaults';
import { resolveParagraph } from '../../model/resolve';
import type { Align, BorderLine, ListDef, ListLevel, NamedStyle, ParaBorders, ParaProps, TabStop, TextStyle } from '../../model/styles';
import { LIST_LEVELS, isEmptyObject } from '../../model/styles';
import { HIGHLIGHTS, builtInForName, fromHex, fromTwips, num, onOff, readBorder, readNumFmt, round2 } from './convert';

export interface Theme {
  major: string;
  minor: string;
}

/** Heading and body fonts of the theme (Word 2007's Cambria / Calibri when there is none). */
export function readTheme(root: XmlElement | null): Theme {
  const scheme = child(child(root ?? undefined, 'themeElements'), 'fontScheme');
  const face = (name: string) => child(child(scheme, name), 'latin')?.attrs.typeface || undefined;
  return { major: face('majorFont') ?? 'Cambria', minor: face('minorFont') ?? 'Calibri' };
}

// ---------------------------------------------------------------- runs

function font(rFonts: XmlElement | undefined, theme: Theme): string | undefined {
  if (!rFonts) return undefined;
  const a = rFonts.attrs;
  const themed = (t: string | undefined) => {
    if (!t) return undefined;
    return t.startsWith('major') ? theme.major : theme.minor;
  };
  return a.ascii || a.hAnsi || themed(a.asciiTheme) || themed(a.hAnsiTheme) || a.eastAsia || a.cs || undefined;
}

function flag(el: XmlElement | undefined): boolean | undefined {
  return el ? onOff(el.attrs.val) : undefined;
}

/** Direct character formatting of a `w:rPr` (or a style's / numbering level's). */
export function readRunProps(rPr: XmlElement | undefined, theme: Theme): TextStyle {
  if (!rPr) return {};
  const s: TextStyle = {};
  const f = font(child(rPr, 'rFonts'), theme);
  if (f) s.font = f;
  const set = <K extends keyof TextStyle>(key: K, value: TextStyle[K] | undefined) => {
    if (value !== undefined) s[key] = value;
  };
  set('bold', flag(child(rPr, 'b')));
  set('italic', flag(child(rPr, 'i')));
  set('allCaps', flag(child(rPr, 'caps')));
  set('smallCaps', flag(child(rPr, 'smallCaps')));
  const strike = flag(child(rPr, 'strike')) ?? flag(child(rPr, 'dstrike'));
  set('strike', strike);
  set('color', fromHex(child(rPr, 'color')?.attrs.val));
  const spacing = fromTwips(child(rPr, 'spacing')?.attrs.val);
  if (spacing) s.spacing = spacing;
  const size = num(child(rPr, 'sz')?.attrs.val);
  if (size && size > 0) s.size = size / 2;
  const highlight = child(rPr, 'highlight')?.attrs.val;
  if (highlight && HIGHLIGHTS[highlight]) s.highlight = HIGHLIGHTS[highlight];
  const shade = fromHex(child(rPr, 'shd')?.attrs.fill);
  if (shade && !s.highlight) s.highlight = shade;
  const u = child(rPr, 'u');
  if (u) s.underline = (u.attrs.val ?? 'single') !== 'none';
  const va = child(rPr, 'vertAlign')?.attrs.val;
  if (va === 'superscript') s.script = 'super';
  else if (va === 'subscript') s.script = 'sub';
  return s;
}

// ---------------------------------------------------------------- paragraphs

export interface ParaInfo {
  props: ParaProps;
  styleId?: string;
  numPr?: { numId: string; level: number };
  sectPr?: XmlElement;
  /** Tab stops measured from the margin, as Word stores them. */
  tabs?: TabStop[];
  /** Outline level (1 = Heading 1), from `w:outlineLvl`. */
  outline?: number;
}

const ALIGN: Record<string, Align> = { left: 'left', start: 'left', center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify', justify: 'justify' };

function readTabs(el: XmlElement | undefined): TabStop[] | undefined {
  if (!el) return undefined;
  const out: TabStop[] = [];
  for (const t of childrenOf(el, 'tab')) {
    const val = t.attrs.val;
    const pos = fromTwips(t.attrs.pos);
    if (pos === undefined || !val || val === 'clear' || val === 'bar' || val === 'num') continue;
    const stop: TabStop = { pos, align: tabAlign(val) };
    const leader = tabLeader(t.attrs.leader);
    if (leader) stop.leader = leader;
    out.push(stop);
  }
  return out;
}

function tabAlign(val: string): TabStop['align'] {
  if (val === 'center') return 'center';
  if (val === 'right' || val === 'end') return 'right';
  return val === 'decimal' ? 'decimal' : 'left';
}

/** The engine's leader for Word's; undefined for none and the ones it has no match for. */
function tabLeader(leader: string | undefined): TabStop['leader'] {
  if (leader === 'dot' || leader === 'middleDot') return 'dot';
  if (leader === 'hyphen') return 'hyphen';
  if (leader === 'underscore' || leader === 'heavy') return 'underscore';
  return undefined;
}

function readParaBorders(el: XmlElement | undefined): ParaBorders | undefined {
  if (!el) return undefined;
  const out: ParaBorders = {};
  const side = (key: keyof ParaBorders, ...names: string[]) => {
    for (const n of names) {
      const line = readBorder(child(el, n)?.attrs);
      if (line && line.width > 0) {
        out[key] = line;
        return;
      }
    }
  };
  side('top', 'top');
  side('bottom', 'bottom');
  side('left', 'left', 'start');
  side('right', 'right', 'end');
  return isEmptyObject(out) ? undefined : out;
}

/** A `w:pPr` (of a paragraph or a paragraph style). */
export function readParaProps(pPr: XmlElement | undefined): ParaInfo {
  const props: ParaProps = {};
  const info: ParaInfo = { props };
  if (!pPr) return info;
  const styleId = child(pPr, 'pStyle')?.attrs.val;
  if (styleId) info.styleId = styleId;
  readParaFlags(pPr, props);
  const numPr = readNumPr(child(pPr, 'numPr'));
  if (numPr) info.numPr = numPr;
  const borders = readParaBorders(child(pPr, 'pBdr'));
  if (borders) props.borders = borders;
  const shading = fromHex(child(pPr, 'shd')?.attrs.fill);
  if (shading) props.shading = shading;
  const tabs = readTabs(child(pPr, 'tabs'));
  if (tabs?.length) info.tabs = tabs;
  if (flag(child(pPr, 'bidi'))) props.direction = 'rtl';
  readSpacing(child(pPr, 'spacing')?.attrs, props);
  readIndent(child(pPr, 'ind')?.attrs, props);
  const jc = child(pPr, 'jc')?.attrs.val;
  if (jc && ALIGN[jc]) props.align = ALIGN[jc];
  const outline = num(child(pPr, 'outlineLvl')?.attrs.val);
  if (outline !== undefined && outline >= 0 && outline < 9) info.outline = outline + 1;
  const sectPr = child(pPr, 'sectPr');
  if (sectPr) info.sectPr = sectPr;
  return info;
}

function readParaFlags(pPr: XmlElement, props: ParaProps): void {
  for (const key of ['keepNext', 'keepLines', 'pageBreakBefore'] as const) {
    const v = flag(child(pPr, key));
    if (v !== undefined) props[key] = v;
  }
  if (flag(child(pPr, 'widowControl')) === false) props.widowControl = false;
}

function readNumPr(numPr: XmlElement | undefined): ParaInfo['numPr'] {
  const numId = child(numPr, 'numId')?.attrs.val;
  if (!numPr || numId === undefined) return undefined;
  return { numId, level: Math.min(LIST_LEVELS - 1, Math.max(0, num(child(numPr, 'ilvl')?.attrs.val) ?? 0)) };
}

/** `w:spacing`: space before and after, and line height (a multiple, or exact / at least in points). */
function readSpacing(spacing: XmlElement['attrs'] | undefined, props: ParaProps): void {
  if (!spacing) return;
  const before = fromTwips(spacing.before);
  const after = fromTwips(spacing.after);
  if (before !== undefined) props.spaceBefore = before;
  if (after !== undefined) props.spaceAfter = after;
  const line = num(spacing.line);
  if (line !== undefined && line > 0) {
    if (spacing.lineRule === 'exact' || spacing.lineRule === 'atLeast') props.lineHeightExact = round2(line / 20);
    else props.lineHeight = round2(line / 240);
  }
}

/** `w:ind`: left and right indents, and a hanging or first-line indent. */
function readIndent(ind: XmlElement['attrs'] | undefined, props: ParaProps): void {
  if (!ind) return;
  const left = fromTwips(ind.left ?? ind.start);
  const right = fromTwips(ind.right ?? ind.end);
  const hanging = fromTwips(ind.hanging);
  const first = fromTwips(ind.firstLine);
  if (left !== undefined) props.indentLeft = left;
  if (right !== undefined) props.indentRight = right;
  if (hanging !== undefined) props.indentFirst = -hanging;
  else if (first !== undefined) props.indentFirst = first;
}

/** Tab stops moved from Word's margin-relative positions to the engine's indent-relative ones. */
export function relativeTabs(tabs: TabStop[], base: number): TabStop[] {
  return tabs.map((t) => ({ ...t, pos: round2(t.pos - base) })).filter((t) => t.pos > 0);
}

// ---------------------------------------------------------------- styles part

export interface StyleSheet {
  styles: Record<string, NamedStyle>;
  /** Word paragraph style id → engine style id. */
  paraIds: Map<string, string>;
  /** Engine style id → the list its paragraphs are in (Word's List Bullet and friends). */
  styleLists: Map<string, { numId: string; level: number }>;
  /** Word character style id → its formatting (basedOn chain folded in). */
  charStyles: Map<string, TextStyle>;
  /** Word table style id → its default border (basedOn chain followed). */
  tableBorders: Map<string, BorderLine>;
  /** Word table style id → its default cell padding. */
  tablePadding: Map<string, number>;
}

interface RawStyle {
  type: string;
  id: string;
  name: string;
  basedOn?: string;
  next?: string;
  el: XmlElement;
}

/** The first border a `w:tblBorders` sets, inner ones first (they are what most cells show). */
export function tableBorder(el: XmlElement | undefined): BorderLine | undefined {
  if (!el) return undefined;
  for (const name of ['insideH', 'insideV', 'top', 'left', 'start', 'bottom', 'right', 'end']) {
    const line = readBorder(child(el, name)?.attrs);
    if (line) return line;
  }
  return undefined;
}

export function readStyles(root: XmlElement | null, theme: Theme): StyleSheet {
  const raw = readRawStyles(root);
  const defaults = child(root ?? undefined, 'docDefaults');
  const baseText = readRunProps(child(child(defaults, 'rPrDefault'), 'rPr'), theme);
  const basePara = readParaProps(child(child(defaults, 'pPrDefault'), 'pPr'));
  const paragraphStyles = [...raw.values()].filter((s) => s.type === 'paragraph');
  const paraIds = paragraphStyleIds(paragraphStyles);

  const styles: Record<string, NamedStyle> = {};
  for (const [id, style] of Object.entries(BUILT_IN_STYLES)) styles[id] = structuredClone(style);
  const styleLists = new Map<string, { numId: string; level: number }>();
  const tabsOf = new Map<string, TabStop[]>();
  for (const s of paragraphStyles) {
    const id = paraIds.get(s.id)!;
    const para = readParaProps(child(s.el, 'pPr'));
    const text = readRunProps(child(s.el, 'rPr'), theme);
    styles[id] = paragraphStyle(s, id, para, text, { paraIds, text: baseText, para: basePara });
    const tabs = para.tabs ?? (id === NORMAL ? basePara.tabs : undefined);
    if (tabs) tabsOf.set(id, tabs);
  }
  // Tab stops of a style are measured from that style's own indent.
  for (const [id, tabs] of tabsOf) {
    const base = resolveParagraph({ styles }, { style: id }).indentLeft ?? 0;
    const rel = relativeTabs(tabs, base);
    if (rel.length) styles[id]!.para = { ...styles[id]!.para, tabs: rel };
  }
  // A style in a list puts its paragraphs in it (inherited along basedOn).
  for (const s of paragraphStyles) {
    const numPr = inherited(raw, s.id, (r) => readParaProps(child(r.el, 'pPr')).numPr);
    if (numPr && numPr.numId !== '0') styleLists.set(paraIds.get(s.id)!, numPr);
  }

  const { charStyles, tableBorders, tablePadding } = characterAndTableStyles(raw, theme);
  return { styles, paraIds, styleLists, charStyles, tableBorders, tablePadding };
}

/** The `w:style` elements by Word id (the first of a repeated id wins). */
function readRawStyles(root: XmlElement | null): Map<string, RawStyle> {
  const raw = new Map<string, RawStyle>();
  for (const el of childrenOf(root ?? undefined, 'style')) {
    const id = el.attrs.styleId;
    if (!id || raw.has(id)) continue;
    raw.set(id, {
      type: el.attrs.type ?? 'paragraph',
      id,
      name: child(el, 'name')?.attrs.val ?? id,
      basedOn: child(el, 'basedOn')?.attrs.val,
      next: child(el, 'next')?.attrs.val,
      el,
    });
  }
  return raw;
}

/** Engine ids for the paragraph styles: the default one is normal, built-ins by name, the rest by their Word id. */
function paragraphStyleIds(paragraphStyles: RawStyle[]): Map<string, string> {
  const paraIds = new Map<string, string>();
  const taken = new Set<string>();
  const def = paragraphStyles.find((s) => onOff(s.el.attrs.default) && s.el.attrs.default !== undefined) ?? paragraphStyles.find((s) => s.id === 'Normal');
  if (def) {
    paraIds.set(def.id, NORMAL);
    taken.add(NORMAL);
  }
  for (const s of paragraphStyles) {
    if (paraIds.has(s.id)) continue;
    const builtIn = builtInForName(s.name);
    if (builtIn && !taken.has(builtIn)) {
      paraIds.set(s.id, builtIn);
      taken.add(builtIn);
    }
  }
  for (const s of paragraphStyles) {
    if (paraIds.has(s.id)) continue;
    const id = freeStyleId(s.id, taken);
    paraIds.set(s.id, id);
    taken.add(id);
  }
  return paraIds;
}

/** `wordId`, or `wordId-2`, `-3`, … when that is taken or a built-in style's id. */
function freeStyleId(wordId: string, taken: Set<string>): string {
  let id = wordId;
  let n = 2;
  while (taken.has(id) || Object.hasOwn(BUILT_IN_STYLES, id)) {
    id = `${wordId}-${n}`;
    n++;
  }
  return id;
}

/** What every paragraph style is read against: the engine ids, and the document defaults. */
interface StyleBase {
  paraIds: Map<string, string>;
  text: TextStyle;
  para: ParaInfo;
}

/** A Word paragraph style as the engine style `id`. */
function paragraphStyle(s: RawStyle, id: string, para: ParaInfo, text: TextStyle, base: StyleBase): NamedStyle {
  const builtIn = BUILT_IN_STYLES[id];
  const style: NamedStyle = { name: builtIn?.name ?? s.name };
  if (id === NORMAL) {
    style.text = { font: 'Times New Roman', size: 10, color: '#000000', ...base.text, ...text };
    style.para = { lineHeight: 1, spaceBefore: 0, spaceAfter: 0, ...base.para.props, ...para.props };
  } else {
    style.basedOn = otherStyle(base.paraIds, s.basedOn, id) ?? NORMAL;
    if (!isEmptyObject(text)) style.text = text;
    if (!isEmptyObject(para.props)) style.para = para.props;
    const outline = builtIn?.outline ?? para.outline;
    if (outline !== undefined) style.outline = outline;
  }
  const next = otherStyle(base.paraIds, s.next, id);
  if (next) style.next = next;
  return style;
}

/** The engine id of the Word style `wordId` refers to, unless that is the style `self` itself. */
function otherStyle(paraIds: Map<string, string>, wordId: string | undefined, self: string): string | undefined {
  const id = wordId ? paraIds.get(wordId) : undefined;
  return id && id !== self ? id : undefined;
}

/** Character styles (basedOn chain folded in) and table styles' default border and cell padding. */
function characterAndTableStyles(
  raw: Map<string, RawStyle>,
  theme: Theme,
): Pick<StyleSheet, 'charStyles' | 'tableBorders' | 'tablePadding'> {
  const charStyles = new Map<string, TextStyle>();
  const tableBorders = new Map<string, BorderLine>();
  const tablePadding = new Map<string, number>();
  for (const s of raw.values()) {
    if (s.type === 'character') {
      const chain = chainOf(raw, s.id).reverse();
      const merged = chain.reduce<TextStyle>((acc, r) => ({ ...acc, ...readRunProps(child(r.el, 'rPr'), theme) }), {});
      if (!isEmptyObject(merged)) charStyles.set(s.id, merged);
    } else if (s.type === 'table') {
      const border = inherited(raw, s.id, (r) => tableBorder(child(child(r.el, 'tblPr'), 'tblBorders')));
      if (border) tableBorders.set(s.id, border);
      const pad = inherited(raw, s.id, (r) => fromTwips(child(child(child(r.el, 'tblPr'), 'tblCellMar'), 'left')?.attrs.w));
      if (pad !== undefined) tablePadding.set(s.id, pad);
    }
  }
  return { charStyles, tableBorders, tablePadding };
}

/** The style and its basedOn ancestors, nearest first (cycles cut). */
function chainOf(raw: Map<string, RawStyle>, id: string): RawStyle[] {
  const out: RawStyle[] = [];
  const seen = new Set<string>();
  for (let cur: string | undefined = id; cur && !seen.has(cur); cur = raw.get(cur)?.basedOn) {
    seen.add(cur);
    const s = raw.get(cur);
    if (!s) break;
    out.push(s);
  }
  return out;
}

function inherited<T>(raw: Map<string, RawStyle>, id: string, get: (s: RawStyle) => T | undefined): T | undefined {
  for (const s of chainOf(raw, id)) {
    const v = get(s);
    if (v !== undefined) return v;
  }
  return undefined;
}

// ---------------------------------------------------------------- numbering part

export interface Numbering {
  lists: Record<string, ListDef>;
  /** Word numbering instance → the engine list it counts in, and whether its items are ticked checklist items. */
  nums: Map<string, { listId: string; checked: boolean }>;
}

const CHECK_BOXES = new Set(['☐', '☑', '☒']);

/** Bullet glyphs from symbol fonts (private-use code points) as the Unicode characters they show. */
function bulletGlyph(text: string, fontName: string | undefined): { text: string; remapped: boolean } {
  const code = text.codePointAt(0) ?? 0;
  const symbolFont = !!fontName && /symbol|wingdings|webdings/i.test(fontName);
  const pua = code >= 0xf000 && code <= 0xf0ff;
  const low = pua ? code - 0xf000 : code;
  if (pua || symbolFont) return { text: symbolBullet(low), remapped: true };
  if (text === 'o' && fontName && /courier/i.test(fontName)) return { text: '○', remapped: true };
  return { text: text || '●', remapped: false };
}

/** The Unicode character a symbol-font bullet shows, by its code in the font (a filled circle when unknown). */
function symbolBullet(low: number): string {
  if (low === 0xb7) return '●';
  if (low === 0xa7 || low === 0x6e) return '■';
  if (low === 0x6f || low === 0x71) return '○';
  if (low === 0xd8) return '➢';
  if (low === 0xfc) return '✓';
  if (low === 0x76) return '❖';
  return '●';
}

function readLevel(lvl: XmlElement, index: number, theme: Theme): { level: ListLevel; checked: boolean } {
  const format = readNumFmt(child(lvl, 'numFmt')?.attrs.val);
  const style = readRunProps(child(lvl, 'rPr'), theme);
  let text = child(lvl, 'lvlText')?.attrs.val ?? '';
  let checked = false;
  let fmt = format;
  if (format === 'bullet') {
    if (CHECK_BOXES.has(text)) {
      checked = text !== '☐';
      fmt = 'check';
      text = '☐';
      delete style.font;
    } else {
      const glyph = bulletGlyph(text, style.font);
      text = glyph.text;
      if (glyph.remapped) delete style.font;
    }
  }
  const ind = child(child(lvl, 'pPr'), 'ind')?.attrs;
  const indent = fromTwips(ind?.left ?? ind?.start) ?? 36 * (index + 1);
  const hanging = fromTwips(ind?.hanging) ?? (ind?.firstLine ? -(fromTwips(ind.firstLine) ?? 0) : 18);
  const level: ListLevel = { format: fmt, text, indent, hanging };
  if (fmt !== 'bullet' && fmt !== 'check' && fmt !== 'none') level.start = num(child(lvl, 'start')?.attrs.val) ?? 1;
  if (!isEmptyObject(style)) level.style = style;
  return { level, checked };
}

interface Abstract {
  name?: string;
  styleLink?: string;
  numStyleLink?: string;
  levels: Map<number, XmlElement>;
}

export function readNumbering(root: XmlElement | null, theme: Theme): Numbering {
  const abstracts = readAbstracts(root);
  const lists: Record<string, ListDef> = {};
  const nums = new Map<string, { listId: string; checked: boolean }>();
  for (const el of childrenOf(root ?? undefined, 'num')) {
    const numId = el.attrs.numId;
    const abstractId = child(el, 'abstractNumId')?.attrs.val;
    if (numId === undefined || abstractId === undefined) continue;
    const abstract = definitionOf(abstracts, abstractId);
    if (!abstract) continue;
    const { levels, starts } = instanceLevels(el, abstract);
    // Instances of one definition share their counters in Word, unless they restart it.
    const named = abstract.name?.startsWith('weld:') ? abstract.name.slice(5) : undefined;
    const checkedName = named?.endsWith(':checked') ?? false;
    const base = (checkedName ? named!.slice(0, -8) : named) || `list${abstractId}`;
    const overridden = starts.size > 0 || childrenOf(el, 'lvlOverride').some((o) => child(o, 'lvl'));
    const listId = overridden ? `${base}-${numId}` : base;

    const read = readLevels(levels, starts, theme);
    if (!lists[listId]) lists[listId] = fillLevels(read.levels);
    nums.set(numId, { listId, checked: checkedName || read.checked });
  }
  return { lists, nums };
}

/** The `w:abstractNum` list definitions by id, each with its first level element per level. */
function readAbstracts(root: XmlElement | null): Map<string, Abstract> {
  const abstracts = new Map<string, Abstract>();
  for (const el of childrenOf(root ?? undefined, 'abstractNum')) {
    const id = el.attrs.abstractNumId;
    if (id === undefined) continue;
    const levels = new Map<number, XmlElement>();
    for (const lvl of childrenOf(el, 'lvl')) {
      const i = num(lvl.attrs.ilvl) ?? 0;
      if (i >= 0 && i < LIST_LEVELS && !levels.has(i)) levels.set(i, lvl);
    }
    abstracts.set(id, {
      name: child(el, 'name')?.attrs.val,
      styleLink: child(el, 'styleLink')?.attrs.val,
      numStyleLink: child(el, 'numStyleLink')?.attrs.val,
      levels,
    });
  }
  return abstracts;
}

/** The definition an instance counts in; one with no levels that links to a list style uses that style's definition. */
function definitionOf(abstracts: Map<string, Abstract>, abstractId: string): Abstract | undefined {
  const abstract = abstracts.get(abstractId);
  if (!abstract?.numStyleLink || abstract.levels.size !== 0) return abstract;
  return [...abstracts.values()].find((a) => a.styleLink === abstract.numStyleLink && a.levels.size) ?? abstract;
}

/** An instance's level elements (the definition's, with overridden ones swapped in) and its restarted start numbers. */
function instanceLevels(el: XmlElement, abstract: Abstract): { levels: Map<number, XmlElement>; starts: Map<number, number> } {
  const levels = new Map(abstract.levels);
  const starts = new Map<number, number>();
  for (const o of childrenOf(el, 'lvlOverride')) {
    const i = num(o.attrs.ilvl) ?? 0;
    const start = num(child(o, 'startOverride')?.attrs.val);
    if (start !== undefined) starts.set(i, start);
    const lvl = child(o, 'lvl');
    if (lvl) levels.set(i, lvl);
  }
  return { levels, starts };
}

/** The levels an instance defines (sparse), and whether its first level is a ticked checkbox. */
function readLevels(levels: Map<number, XmlElement>, starts: Map<number, number>, theme: Theme): { levels: ListLevel[]; checked: boolean } {
  const read: ListLevel[] = [];
  let checked = false;
  for (let i = 0; i < LIST_LEVELS; i++) {
    const lvl = levels.get(i);
    if (!lvl) continue;
    const r = readLevel(lvl, i, theme);
    if (i === 0 && r.checked) checked = true;
    if (starts.has(i) && r.level.format !== 'bullet' && r.level.format !== 'check') r.level.start = starts.get(i);
    read[i] = r.level;
  }
  return { levels: read, checked };
}

/** Nine levels, the missing ones from the engine's default bullet or numbered list. */
function fillLevels(read: ListLevel[]): ListDef {
  const first = read.find(Boolean);
  const fallback = first && (first.format === 'bullet' || first.format === 'check') ? bulletList() : numberedList();
  const levels: ListLevel[] = [];
  for (let i = 0; i < LIST_LEVELS; i++) {
    const level = read[i] ?? fallback.levels[i]!;
    levels.push(first?.format === 'check' && !read[i] ? { ...level, format: 'check', text: '☐' } : level);
  }
  return { levels };
}
