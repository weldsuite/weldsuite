/**
 * Formatting out: run properties (`w:rPr`), paragraph properties (`w:pPr`),
 * and the styles and numbering parts built from the document's named styles
 * and list definitions.
 *
 * Child elements are written in the order the schema lists them: Word
 * declares a file damaged when they come in another order.
 */

import { attrs, esc, XML_HEADER } from '@weldsuite/zip-xml';
import { NORMAL } from '../../model/defaults';
import { resolveParagraph } from '../../model/resolve';
import type { BorderLine, ListDef, NamedStyle, ParaBorders, ParaProps, TabStop, TextStyle } from '../../model/styles';
import { BUILT_IN_WORD_STYLES, NS, borderAttrs, halfPoints, hex, highlightName, numFmt, twips } from './convert';

/** What writing paragraph properties needs to know about the document. */
export interface FormatContext {
  styles: Record<string, NamedStyle>;
  lists: Record<string, ListDef>;
  /** Engine style id → Word style id. */
  styleIds: Map<string, string>;
  /** List id → Word numbering instances (a checklist has a second one for ticked items). */
  numIds: Map<string, { numId: number; checkedNumId?: number }>;
}

// ---------------------------------------------------------------- runs

function toggle(name: string, on: boolean): string {
  return on ? `<w:${name}/>` : `<w:${name} w:val="0"/>`;
}

/** The inside of a `w:rPr` for direct character formatting (no `link` / `suggestion`: those are not formatting in Word). */
export function rPrBody(s: TextStyle): string {
  let out = '';
  if (s.font) out += `<w:rFonts${attrs({ 'w:ascii': s.font, 'w:hAnsi': s.font, 'w:eastAsia': s.font, 'w:cs': s.font })}/>`;
  if (s.bold !== undefined) out += toggle('b', s.bold) + toggle('bCs', s.bold);
  if (s.italic !== undefined) out += toggle('i', s.italic) + toggle('iCs', s.italic);
  if (s.allCaps !== undefined) out += toggle('caps', s.allCaps);
  if (s.smallCaps !== undefined) out += toggle('smallCaps', s.smallCaps);
  if (s.strike !== undefined) out += toggle('strike', s.strike);
  if (s.color) out += `<w:color w:val="${hex(s.color)}"/>`;
  if (s.spacing) out += `<w:spacing w:val="${twips(s.spacing)}"/>`;
  if (s.size) out += `<w:sz w:val="${halfPoints(s.size)}"/><w:szCs w:val="${halfPoints(s.size)}"/>`;
  const named = s.highlight ? highlightName(s.highlight) : undefined;
  if (named) out += `<w:highlight w:val="${named}"/>`;
  if (s.underline !== undefined) out += `<w:u w:val="${s.underline ? 'single' : 'none'}"/>`;
  if (s.highlight && !named) out += `<w:shd w:val="clear" w:color="auto" w:fill="${hex(s.highlight)}"/>`;
  if (s.script) out += `<w:vertAlign w:val="${s.script === 'super' ? 'superscript' : 'subscript'}"/>`;
  return out;
}

export function rPrXml(s: TextStyle): string {
  const body = rPrBody(s);
  return body ? `<w:rPr>${body}</w:rPr>` : '';
}

// ---------------------------------------------------------------- paragraphs

const JC: Record<NonNullable<ParaProps['align']>, string> = { left: 'left', center: 'center', right: 'right', justify: 'both' };
const SIDES = ['top', 'left', 'bottom', 'right'] as const;

export type BorderSide = 'top' | 'left' | 'bottom' | 'right' | 'insideH' | 'insideV';

/** A borders element (`w:pBdr`, `w:tcBorders`, `w:tblBorders`) with its sides in schema order. */
export function bordersXml(tag: string, borders: Partial<Record<BorderSide, BorderLine>> | undefined, order: readonly BorderSide[]): string {
  if (!borders) return '';
  let out = '';
  for (const side of order) {
    const line = borders[side];
    if (line) out += `<w:${side}${attrs(borderAttrs(line))}/>`;
  }
  return out ? `<w:${tag}>${out}</w:${tag}>` : '';
}

function tabsXml(tabs: TabStop[] | undefined, base: number): string {
  if (!tabs?.length) return '';
  const items = tabs
    .map((t) => `<w:tab${attrs({ 'w:val': t.align, 'w:leader': t.leader && t.leader !== 'none' ? t.leader : undefined, 'w:pos': twips(t.pos + base) })}/>`)
    .join('');
  return `<w:tabs>${items}</w:tabs>`;
}

type ParaFormat = Omit<ParaProps, 'style' | 'list' | 'checked' | 'anchorId'>;

/** The `w:pPr` children after numbering, shared by paragraphs and paragraph styles. */
function paraBody(p: ParaFormat, tabBase: number, borders: ParaBorders | undefined): string {
  let out = '';
  out += bordersXml('pBdr', borders, SIDES);
  if (p.shading) out += `<w:shd w:val="clear" w:color="auto" w:fill="${hex(p.shading)}"/>`;
  out += tabsXml(p.tabs, tabBase);
  if (p.direction) out += toggle('bidi', p.direction === 'rtl');
  const spacing: Record<string, string | number | undefined> = {};
  if (p.spaceBefore !== undefined) spacing['w:before'] = twips(p.spaceBefore);
  if (p.spaceAfter !== undefined) spacing['w:after'] = twips(p.spaceAfter);
  if (p.lineHeightExact !== undefined) {
    spacing['w:line'] = twips(p.lineHeightExact);
    spacing['w:lineRule'] = 'exact';
  } else if (p.lineHeight !== undefined) {
    spacing['w:line'] = Math.round(p.lineHeight * 240);
    spacing['w:lineRule'] = 'auto';
  }
  if (Object.keys(spacing).length) out += `<w:spacing${attrs(spacing)}/>`;
  const ind: Record<string, number | undefined> = {};
  if (p.indentLeft !== undefined) ind['w:left'] = twips(p.indentLeft);
  if (p.indentRight !== undefined) ind['w:right'] = twips(p.indentRight);
  if (p.indentFirst !== undefined) {
    if (p.indentFirst < 0) ind['w:hanging'] = twips(-p.indentFirst);
    else ind['w:firstLine'] = twips(p.indentFirst);
  }
  if (Object.keys(ind).length) out += `<w:ind${attrs(ind)}/>`;
  if (p.align) out += `<w:jc w:val="${JC[p.align]}"/>`;
  return out;
}

function flowFlags(p: ParaFormat): string {
  let out = '';
  if (p.keepNext !== undefined) out += toggle('keepNext', p.keepNext);
  if (p.keepLines !== undefined) out += toggle('keepLines', p.keepLines);
  if (p.pageBreakBefore !== undefined) out += toggle('pageBreakBefore', p.pageBreakBefore);
  if (p.widowControl !== undefined) out += toggle('widowControl', p.widowControl);
  return out;
}

/** Where a paragraph's tab stops are measured from (the engine measures from the text's left edge, Word from the margin). */
export function tabBase(ctx: FormatContext, props: ParaProps): number {
  if (props.list) {
    const level = ctx.lists[props.list.id]?.levels[props.list.level];
    if (level) return level.indent;
  }
  return resolveParagraph(ctx, props).indentLeft ?? 0;
}

export interface PPrExtras {
  /** A `w:sectPr` ending the section at this paragraph. */
  sectPr?: string;
  /** Replaces the paragraph's borders (a horizontal rule is a bottom border). */
  borders?: ParaBorders;
}

export function pPrXml(props: ParaProps, ctx: FormatContext, extras: PPrExtras = {}): string {
  let out = '';
  if (props.style && props.style !== NORMAL) {
    const id = ctx.styleIds.get(props.style);
    if (id) out += `<w:pStyle w:val="${id}"/>`;
  }
  out += flowFlags(props);
  if (props.list) {
    const num = ctx.numIds.get(props.list.id);
    if (num) {
      const numId = props.checked && num.checkedNumId ? num.checkedNumId : num.numId;
      out += `<w:numPr><w:ilvl w:val="${Math.min(8, Math.max(0, props.list.level))}"/><w:numId w:val="${numId}"/></w:numPr>`;
    }
  }
  out += paraBody(props, props.tabs?.length ? tabBase(ctx, props) : 0, extras.borders ?? props.borders);
  out += extras.sectPr ?? '';
  return out ? `<w:pPr>${out}</w:pPr>` : '';
}

// ---------------------------------------------------------------- styles part

/** Word style ids for the document's named styles: the usual ones for built-ins, the engine id cleaned up for others. */
export function wordStyleIds(styles: Record<string, NamedStyle>): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>(['DefaultParagraphFont', 'TableNormal', 'NoList']);
  for (const id of Object.keys(styles)) {
    const builtIn = BUILT_IN_WORD_STYLES[id];
    if (builtIn) {
      out.set(id, builtIn.id);
      used.add(builtIn.id);
    }
  }
  for (const id of Object.keys(styles)) {
    if (out.has(id)) continue;
    const base = id.replace(/[^A-Za-z0-9]/g, '') || 'Style';
    let wid = base;
    for (let i = 2; used.has(wid); i++) wid = `${base}${i}`;
    used.add(wid);
    out.set(id, wid);
  }
  return out;
}

export function stylesXml(ctx: FormatContext): string {
  let body = '<w:docDefaults><w:rPrDefault><w:rPr><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr/></w:pPrDefault></w:docDefaults>';
  const ids = Object.keys(ctx.styles).sort((a, b) => (a === NORMAL ? -1 : b === NORMAL ? 1 : a < b ? -1 : 1));
  for (const id of ids) {
    const style = ctx.styles[id]!;
    const wid = ctx.styleIds.get(id)!;
    const builtIn = BUILT_IN_WORD_STYLES[id];
    const name = builtIn?.name ?? style.name;
    let s = `<w:style${attrs({ 'w:type': 'paragraph', 'w:default': id === NORMAL ? '1' : undefined, 'w:styleId': wid })}>`;
    s += `<w:name w:val="${esc(name)}"/>`;
    if (id !== NORMAL) {
      const based = style.basedOn && ctx.styleIds.get(style.basedOn);
      s += `<w:basedOn w:val="${based || 'Normal'}"/>`;
    }
    const next = style.next && ctx.styleIds.get(style.next);
    if (next) s += `<w:next w:val="${next}"/>`;
    s += '<w:qFormat/>';
    const para: ParaFormat = { ...style.para };
    if (id === NORMAL && para.widowControl === undefined) para.widowControl = true;
    let pPr = flowFlags(para) + paraBody(para, para.tabs?.length ? (resolveParagraph(ctx, { style: id }).indentLeft ?? 0) : 0, para.borders);
    if (style.outline && style.outline >= 1 && style.outline <= 9) pPr += `<w:outlineLvl w:val="${style.outline - 1}"/>`;
    if (pPr) s += `<w:pPr>${pPr}</w:pPr>`;
    s += rPrXml(style.text ?? {});
    body += `${s}</w:style>`;
  }
  body +=
    '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>' +
    '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
    '<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/></w:style>';
  return `${XML_HEADER}<w:styles xmlns:w="${NS.w}">${body}</w:styles>`;
}

// ---------------------------------------------------------------- numbering part

/** Numbering instances for every list (one abstract definition each, plus a ticked twin for checklists). */
export function numberingIds(lists: Record<string, ListDef>): Map<string, { numId: number; checkedNumId?: number }> {
  const out = new Map<string, { numId: number; checkedNumId?: number }>();
  let next = 1;
  for (const id of Object.keys(lists).sort()) {
    const entry: { numId: number; checkedNumId?: number } = { numId: next++ };
    if (lists[id]!.levels.some((l) => l.format === 'check')) entry.checkedNumId = next++;
    out.set(id, entry);
  }
  return out;
}

function levelXml(def: ListDef, i: number, checked: boolean): string {
  const level = def.levels[i]!;
  const isCheck = level.format === 'check';
  const text = isCheck ? (checked ? '☑' : '☐') : level.format === 'none' ? '' : level.text;
  let out = `<w:lvl w:ilvl="${i}">`;
  out += `<w:start w:val="${level.start ?? 1}"/>`;
  out += `<w:numFmt w:val="${numFmt(level.format)}"/>`;
  out += `<w:lvlText w:val="${esc(text)}"/>`;
  out += '<w:lvlJc w:val="left"/>';
  out += `<w:pPr><w:ind w:left="${twips(level.indent)}" w:hanging="${twips(level.hanging)}"/></w:pPr>`;
  out += rPrXml(level.style ?? {});
  return `${out}</w:lvl>`;
}

export function numberingXml(lists: Record<string, ListDef>, ids: Map<string, { numId: number; checkedNumId?: number }>): string {
  let abstracts = '';
  let nums = '';
  for (const [id, entry] of ids) {
    const def = lists[id]!;
    const variants: [number, boolean][] = [[entry.numId, false]];
    if (entry.checkedNumId) variants.push([entry.checkedNumId, true]);
    for (const [numId, checked] of variants) {
      const abstractId = numId - 1;
      let a = `<w:abstractNum w:abstractNumId="${abstractId}"><w:multiLevelType w:val="hybridMultilevel"/>`;
      a += `<w:name w:val="${esc(`weld:${id}${checked ? ':checked' : ''}`)}"/>`;
      for (let i = 0; i < Math.min(9, def.levels.length); i++) a += levelXml(def, i, checked);
      abstracts += `${a}</w:abstractNum>`;
      nums += `<w:num w:numId="${numId}"><w:abstractNumId w:val="${abstractId}"/></w:num>`;
    }
  }
  return `${XML_HEADER}<w:numbering xmlns:w="${NS.w}">${abstracts}${nums}</w:numbering>`;
}
