/**
 * The styles part (`xl/styles.xml`): reading cell formats (`cellXfs`) and
 * conditional-format styles (`dxfs`) into WeldSheets styles, and writing a
 * workbook's styles back as deduplicated fonts, fills, borders and formats.
 *
 * Imported text without a colour of its own stays without one, as does text
 * in the file's default font and size: WeldSheets then draws it in its own
 * default, which follows dark mode.
 */

import { attrs, child, childrenOf, esc, type XmlElement } from '@weldsuite/zip-xml';
import type { FormatLocale } from '../../format/number-format';
import type { ConditionalStyle } from '../../model/rules';
import type { BorderSide, CellStyle } from '../../model/styles';
import { resolveColor, toArgb } from './colors';

export interface StyleSheet {
  /** The look of each `cellXfs` entry; undefined where it is the default. */
  xfs: (CellStyle | undefined)[];
  dxfs: ConditionalStyle[];
}

/** Excel's built-in number formats (ids below 164) that WeldSheets can show. */
const BUILT_IN_FORMATS: Record<number, string> = {
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  5: '"$"#,##0_);("$"#,##0)',
  6: '"$"#,##0_);[Red]("$"#,##0)',
  7: '"$"#,##0.00_);("$"#,##0.00)',
  8: '"$"#,##0.00_);[Red]("$"#,##0.00)',
  9: '0%',
  10: '0.00%',
  11: '0.00E+00',
  12: '# ?/?',
  13: '# ??/??',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM',
  20: 'h:mm',
  21: 'h:mm:ss',
  37: '#,##0 ;(#,##0)',
  38: '#,##0 ;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)',
  40: '#,##0.00;[Red](#,##0.00)',
  45: 'mm:ss',
  46: '[h]:mm:ss',
  47: 'mm:ss.0',
  48: '##0.0E+0',
  49: '@',
};

/** Formats 14 and 22 are the system's short date (and time): shown in the reader's date order. */
function localDate(locale: FormatLocale): string {
  if (locale.dateOrder === 'dmy') return 'dd-mm-yyyy';
  if (locale.dateOrder === 'ymd') return 'yyyy-mm-dd';
  return 'm/d/yyyy';
}

export function builtInFormat(id: number, locale: FormatLocale): string | undefined {
  if (id === 14) return localDate(locale);
  if (id === 22) return `${localDate(locale)} h:mm`;
  return BUILT_IN_FORMATS[id];
}

const BORDER_STYLES: Record<string, BorderSide['style']> = {
  thin: 'thin',
  hair: 'thin',
  medium: 'medium',
  thick: 'thick',
  dashed: 'dashed',
  mediumDashed: 'dashed',
  dashDot: 'dashed',
  mediumDashDot: 'dashed',
  dashDotDot: 'dashed',
  mediumDashDotDot: 'dashed',
  slantDashDot: 'dashed',
  dotted: 'dotted',
  double: 'double',
};

const H_ALIGN: Record<string, CellStyle['hAlign']> = {
  left: 'left',
  center: 'center',
  centerContinuous: 'center',
  right: 'right',
  justify: 'justify',
  distributed: 'justify',
  fill: 'left',
};

const V_ALIGN: Record<string, CellStyle['vAlign']> = { top: 'top', center: 'middle', justify: 'middle', distributed: 'middle' };

const BLACK = '#000000';

interface FontBase {
  name?: string;
  size?: number;
}

export function readStyles(root: XmlElement | null, theme: string[], locale: FormatLocale): StyleSheet {
  if (!root) return { xfs: [], dxfs: [] };
  const formats = new Map<number, string>();
  for (const nf of childrenOf(child(root, 'numFmts'), 'numFmt')) formats.set(Number(nf.attrs.numFmtId), nf.attrs.formatCode ?? '');
  const formatOf = (id: number) => formats.get(id) ?? builtInFormat(id, locale);

  const fontEls = childrenOf(child(root, 'fonts'), 'font');
  const first = fontEls[0];
  const base: FontBase = { name: child(first, 'name')?.attrs.val, size: Number(child(first, 'sz')?.attrs.val) || undefined };
  const fonts = fontEls.map((f) => fontStyle(f, theme, base));
  const fills = childrenOf(child(root, 'fills'), 'fill').map((f) => fillColor(f, theme, false));
  const borders = childrenOf(child(root, 'borders'), 'border').map((b) => borderStyle(b, theme));

  const xfs = childrenOf(child(root, 'cellXfs'), 'xf').map((xf) => {
    const a = xf.attrs;
    const style: CellStyle = { ...fonts[Number(a.fontId ?? 0)], ...borders[Number(a.borderId ?? 0)] };
    const fill = fills[Number(a.fillId ?? 0)];
    if (fill) style.fill = fill;
    const code = formatOf(Number(a.numFmtId ?? 0));
    if (code && code !== 'General') style.numFmt = code;
    Object.assign(style, alignmentStyle(child(xf, 'alignment')));
    return Object.keys(style).length ? style : undefined;
  });

  const dxfs = childrenOf(child(root, 'dxfs'), 'dxf').map((dxf) => {
    const font = fontStyle(child(dxf, 'font'), theme, {}, true);
    const style: ConditionalStyle = {};
    if (font.bold) style.bold = true;
    if (font.italic) style.italic = true;
    if (font.underline) style.underline = true;
    if (font.strike) style.strike = true;
    if (font.color) style.color = font.color;
    const fill = fillColor(child(dxf, 'fill'), theme, true);
    if (fill) style.fill = fill;
    return style;
  });
  return { xfs, dxfs };
}

function isOn(el: XmlElement | undefined): boolean {
  return !!el && el.attrs.val !== '0' && el.attrs.val !== 'false';
}

/** A font's differences from the file's default font. A conditional format keeps even black text. */
function fontStyle(el: XmlElement | undefined, theme: string[], base: FontBase, keepBlack = false): CellStyle {
  const style: CellStyle = {};
  if (!el) return style;
  const name = child(el, 'name')?.attrs.val;
  if (name && name !== base.name) style.fontFamily = name;
  const size = Number(child(el, 'sz')?.attrs.val);
  if (size > 0 && size !== base.size) style.fontSize = size;
  if (isOn(child(el, 'b'))) style.bold = true;
  if (isOn(child(el, 'i'))) style.italic = true;
  if (isOn(child(el, 'strike'))) style.strike = true;
  const underline = child(el, 'u');
  if (underline && underline.attrs.val !== 'none') style.underline = true;
  const color = resolveColor(child(el, 'color'), theme);
  if (color && (keepBlack || color !== BLACK)) style.color = color;
  return style;
}

/** A solid fill's colour. Conditional formats keep it in `bgColor`, cells in `fgColor`. */
function fillColor(el: XmlElement | undefined, theme: string[], conditional: boolean): string | undefined {
  const gradientStop = child(child(el, 'gradientFill'), 'stop');
  if (gradientStop) return resolveColor(child(gradientStop, 'color'), theme);
  const pattern = child(el, 'patternFill');
  if (!pattern) return undefined;
  const type = pattern.attrs.patternType;
  if (conditional) {
    if (type === 'none') return undefined;
    return resolveColor(child(pattern, 'bgColor'), theme) ?? resolveColor(child(pattern, 'fgColor'), theme);
  }
  if (!type || type === 'none' || type === 'gray125') return undefined;
  return resolveColor(child(pattern, 'fgColor'), theme) ?? resolveColor(child(pattern, 'bgColor'), theme);
}

function borderStyle(el: XmlElement, theme: string[]): CellStyle {
  const style: CellStyle = {};
  const sides = [
    ['left', 'borderLeft'],
    ['right', 'borderRight'],
    ['top', 'borderTop'],
    ['bottom', 'borderBottom'],
  ] as const;
  for (const [name, key] of sides) {
    const side = child(el, name);
    const kind = side ? BORDER_STYLES[side.attrs.style ?? ''] : undefined;
    if (!side || !kind) continue;
    const color = resolveColor(child(side, 'color'), theme);
    style[key] = color && color !== BLACK ? { style: kind, color } : { style: kind };
  }
  return style;
}

function alignmentStyle(el: XmlElement | undefined): CellStyle {
  const style: CellStyle = {};
  if (!el) return style;
  const a = el.attrs;
  const h = H_ALIGN[a.horizontal ?? ''];
  if (h) style.hAlign = h;
  const v = V_ALIGN[a.vertical ?? ''];
  if (v) style.vAlign = v;
  if (a.wrapText === '1' || a.wrapText === 'true') style.wrap = 'wrap';
  const indent = Number(a.indent);
  if (indent > 0) style.indent = Math.min(indent, 15);
  const rotation = Number(a.textRotation);
  if (rotation > 0 && rotation <= 90) style.rotation = rotation;
  else if (rotation > 90 && rotation <= 180) style.rotation = 90 - rotation;
  return style;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** The font every written cell starts from: WeldSheets' own default. */
export const DEFAULT_FONT = { name: 'Arial', size: 10 };

const WRITE_BORDER: Record<BorderSide['style'], string> = {
  thin: 'thin',
  medium: 'medium',
  thick: 'thick',
  dashed: 'dashed',
  dotted: 'dotted',
  double: 'double',
};

/** Collects the styles cells use and assigns their `cellXfs` / `dxfs` indices. */
export class StylesWriter {
  private readonly fonts = new Index();
  private readonly fills = new Index();
  private readonly borders = new Index();
  private readonly formats = new Map<string, number>();
  private readonly xfs = new Index();
  private readonly dxfs = new Index();

  constructor() {
    this.fonts.add(fontXml({}));
    this.fills.add('<fill><patternFill patternType="none"/></fill>');
    this.fills.add('<fill><patternFill patternType="gray125"/></fill>');
    this.borders.add('<border><left/><right/><top/><bottom/><diagonal/></border>');
    this.xfs.add(xfXml(0, 0, 0, 0, ''));
  }

  /** The `s` index for a cell style (0 for the default look). */
  xf(style: CellStyle | undefined): number {
    if (!style) return 0;
    const font = this.fonts.add(fontXml(style));
    const argb = toArgb(style.fill);
    const fill = argb ? this.fills.add(`<fill><patternFill patternType="solid"><fgColor rgb="${argb}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const border = this.borders.add(borderXml(style));
    const numFmt = style.numFmt ? this.formatId(style.numFmt) : 0;
    return this.xfs.add(xfXml(numFmt, font, fill, border, alignmentXml(style)));
  }

  /** The `dxfId` for a conditional format's style. */
  dxf(style: ConditionalStyle): number {
    const font = style.bold || style.italic || style.underline || style.strike || style.color ? fontXml(style, true) : '';
    const argb = toArgb(style.fill);
    const fill = argb ? `<fill><patternFill patternType="solid"><bgColor rgb="${argb}"/></patternFill></fill>` : '';
    return this.dxfs.add(`<dxf>${font}${fill}</dxf>`);
  }

  private formatId(code: string): number {
    for (const [id, builtIn] of Object.entries(BUILT_IN_FORMATS)) if (builtIn === code) return Number(id);
    let id = this.formats.get(code);
    if (id === undefined) {
      id = 164 + this.formats.size;
      this.formats.set(code, id);
    }
    return id;
  }

  toXml(): string {
    const numFmts = [...this.formats].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${esc(code)}"/>`);
    return [
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
      numFmts.length ? `<numFmts count="${numFmts.length}">${numFmts.join('')}</numFmts>` : '',
      this.fonts.list('fonts'),
      this.fills.list('fills'),
      this.borders.list('borders'),
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
      this.xfs.list('cellXfs'),
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>',
      this.dxfs.list('dxfs'),
      '</styleSheet>',
    ].join('');
  }
}

/** XML snippets numbered in the order they are first added. */
class Index {
  private readonly items = new Map<string, number>();

  add(xml: string): number {
    let i = this.items.get(xml);
    if (i === undefined) {
      i = this.items.size;
      this.items.set(xml, i);
    }
    return i;
  }

  list(tag: string): string {
    return `<${tag} count="${this.items.size}">${[...this.items.keys()].join('')}</${tag}>`;
  }
}

function fontXml(style: CellStyle, conditional = false): string {
  let xml = '<font>';
  if (style.bold) xml += '<b/>';
  if (style.italic) xml += '<i/>';
  if (style.strike) xml += '<strike/>';
  if (style.underline) xml += '<u/>';
  if (!conditional) xml += `<sz val="${style.fontSize ?? DEFAULT_FONT.size}"/>`;
  const argb = toArgb(style.color);
  if (argb) xml += `<color rgb="${argb}"/>`;
  if (!conditional) xml += `<name val="${esc(style.fontFamily ?? DEFAULT_FONT.name)}"/><family val="2"/>`;
  return `${xml}</font>`;
}

function borderXml(style: CellStyle): string {
  const side = (tag: string, s: BorderSide | undefined) => {
    if (!s) return `<${tag}/>`;
    const argb = toArgb(s.color);
    const color = argb ? `<color rgb="${argb}"/>` : '<color auto="1"/>';
    return `<${tag} style="${WRITE_BORDER[s.style] ?? 'thin'}">${color}</${tag}>`;
  };
  return `<border>${side('left', style.borderLeft)}${side('right', style.borderRight)}${side('top', style.borderTop)}${side('bottom', style.borderBottom)}<diagonal/></border>`;
}

function alignmentXml(style: CellStyle): string {
  let rotation: number | undefined;
  if (style.rotation) rotation = style.rotation > 0 ? style.rotation : 90 - style.rotation;
  const a = attrs({
    horizontal: style.hAlign,
    vertical: style.vAlign === 'middle' ? 'center' : style.vAlign,
    wrapText: style.wrap === 'wrap',
    indent: style.indent || undefined,
    textRotation: rotation,
  });
  return a ? `<alignment${a}/>` : '';
}

function xfXml(numFmt: number, font: number, fill: number, border: number, alignment: string): string {
  const a = attrs({
    numFmtId: numFmt,
    fontId: font,
    fillId: fill,
    borderId: border,
    xfId: 0,
    applyNumberFormat: numFmt > 0,
    applyFont: font > 0,
    applyFill: fill > 0,
    applyBorder: border > 0,
    applyAlignment: !!alignment,
  });
  return alignment ? `<xf${a}>${alignment}</xf>` : `<xf${a}/>`;
}
