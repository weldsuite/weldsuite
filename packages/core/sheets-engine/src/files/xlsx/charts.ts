/**
 * Charts in .xlsx: DrawingML. A sheet's charts sit in one drawing part
 * (`xl/drawings/drawingN.xml`), each anchored between two cells and pointing
 * at a chart part (`xl/charts/chartN.xml`) that holds its type, series
 * references and their last values.
 *
 * Column, bar, line, area, pie, doughnut and scatter charts are read and
 * written; other kinds, pictures and shapes are left out with a warning.
 */

import type { Engine } from '../../calc/engine';
import { chartData } from '../../charts/data';
import { EN_LOCALE, formatValue, type FormatLocale } from '../../format/number-format';
import { tokenize } from '../../formula/lexer';
import { printRef } from '../../formula/references';
import { AxisDims } from '../../model/axis';
import type { Chart, ChartSeries, ChartType } from '../../model/charts';
import type { Sheet, SheetSnapshot } from '../../model/workbook';
import type { ImportWarning } from '../types';
import { XML_HEADER, child, childrenOf, esc, parseXml, type XmlElement } from '../xml';
import type { ZipReader } from '../zip';
import { resolveColor } from './colors';
import { fromExcelFormula } from './formulas';

/** English Metric Units per pixel (914400 per inch, 96 pixels per inch). */
const EMU = 9525;
const NS_C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL_CHART = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart';
const CAT_AX = 111111;
const VAL_AX = 222222;

export const CT_DRAWING = 'application/vnd.openxmlformats-officedocument.drawing+xml';
export const CT_CHART = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface DrawingParts {
  drawing: string;
  /** The drawing's relationships to its charts. */
  rels: string;
  /** Chart parts, numbered from `firstChart`. */
  charts: string[];
}

/** A sheet's charts as a drawing and its chart parts (chart parts numbered from `firstChart`). */
export function writeDrawing(engine: Engine, sheet: Sheet, firstChart: number, locale: FormatLocale = EN_LOCALE): DrawingParts {
  const anchors: string[] = [];
  const rels: string[] = [];
  const charts: string[] = [];
  sheet.charts.forEach((chart, i) => {
    const rId = `rId${i + 1}`;
    anchors.push(anchorXml(sheet, chart, i, rId));
    rels.push(`<Relationship Id="${rId}" Type="${REL_CHART}" Target="../charts/chart${firstChart + i}.xml"/>`);
    charts.push(chartXml(engine, sheet, chart, locale));
  });
  return {
    drawing: `${XML_HEADER}<xdr:wsDr xmlns:xdr="${NS_XDR}" xmlns:a="${NS_A}">${anchors.join('')}</xdr:wsDr>`,
    rels: `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`,
    charts,
  };
}

/** The cell and offset (EMU) a pixel position along an axis falls in. */
function cellAt(axis: AxisDims, px: number): { index: number; off: number } {
  const index = axis.indexAt(Math.max(0, px));
  return { index, off: Math.max(0, Math.round((px - axis.offsetOf(index)) * EMU)) };
}

function anchorXml(sheet: Sheet, chart: Chart, i: number, rId: string): string {
  const { row, col, dx, dy } = chart.anchor;
  const x = sheet.cols.offsetOf(col) + dx;
  const y = sheet.rows.offsetOf(row) + dy;
  const to = { col: cellAt(sheet.cols, x + chart.width), row: cellAt(sheet.rows, y + chart.height) };
  const point = (tag: string, c: number, cOff: number, r: number, rOff: number) =>
    `<xdr:${tag}><xdr:col>${c}</xdr:col><xdr:colOff>${cOff}</xdr:colOff><xdr:row>${r}</xdr:row><xdr:rowOff>${rOff}</xdr:rowOff></xdr:${tag}>`;
  return [
    '<xdr:twoCellAnchor editAs="oneCell">',
    point('from', col, Math.round(dx * EMU), row, Math.round(dy * EMU)),
    point('to', to.col.index, to.col.off, to.row.index, to.row.off),
    `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="Chart ${i + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>`,
    '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>',
    `<a:graphic><a:graphicData uri="${NS_C}"><c:chart xmlns:c="${NS_C}" xmlns:r="${NS_R}" r:id="${rId}"/></a:graphicData></a:graphic>`,
    '</xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>',
  ].join('');
}

/** A reference with its sheet named, as chart formulas must be. */
function qualified(ref: string, sheetName: string): string {
  try {
    const tokens = tokenize(ref).filter((t) => t.type !== 'ws');
    const only = tokens[0];
    if (tokens.length === 1 && only?.type === 'ref' && only.ref.sheet === null) return printRef({ ...only.ref, sheet: sheetName });
  } catch {
    // Not a reference: written as it is.
  }
  return ref;
}

const hex = (color: string) => color.replace('#', '').toUpperCase();
const LEGEND_POS: Record<NonNullable<Chart['legend']>, string | null> = { right: 'r', bottom: 'b', top: 't', none: null };

function chartXml(engine: Engine, sheet: Sheet, chart: Chart, locale: FormatLocale): string {
  const data = chartData(engine, sheet.id, chart);
  const pie = chart.type === 'pie' || chart.type === 'doughnut';
  const labels = data.categories.map((v) => formatValue(v, data.categoryFormat, locale).text);
  const series = chart.series
    .map((s, i) => seriesXml(chart, s, i, sheet.name, labels, data.series[i]?.values ?? [], data.series[i]?.x, data.series[i]?.color ?? '#4285f4', data.series[i]?.name ?? ''))
    .join('');
  const plot = plotXml(chart, series);
  const axes = pie ? '' : axesXml(chart);
  const legendPos = LEGEND_POS[chart.legend ?? 'bottom'];
  const legend = legendPos ? `<c:legend><c:legendPos val="${legendPos}"/><c:overlay val="0"/></c:legend>` : '';
  return [
    `${XML_HEADER}<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"><c:roundedCorners val="0"/><c:chart>`,
    chart.title ? titleXml(chart.title) : '',
    `<c:autoTitleDeleted val="${chart.title ? 0 : 1}"/>`,
    `<c:plotArea><c:layout/>${plot}${axes}</c:plotArea>`,
    legend,
    '<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>',
  ].join('');
}

function titleXml(text: string): string {
  return `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr/></a:pPr><a:r><a:t>${esc(text)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;
}

const GROUPING: Record<string, string> = { stacked: 'stacked', percent: 'percentStacked' };

function plotXml(chart: Chart, series: string): string {
  const axIds = `<c:axId val="${CAT_AX}"/><c:axId val="${VAL_AX}"/>`;
  switch (chart.type) {
    case 'column':
    case 'bar': {
      const grouping = GROUPING[chart.stacking ?? ''] ?? 'clustered';
      const overlap = chart.stacking ? '<c:overlap val="100"/>' : '';
      return `<c:barChart><c:barDir val="${chart.type === 'bar' ? 'bar' : 'col'}"/><c:grouping val="${grouping}"/><c:varyColors val="0"/>${series}<c:gapWidth val="150"/>${overlap}${axIds}</c:barChart>`;
    }
    case 'line':
      return `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}<c:marker val="1"/>${axIds}</c:lineChart>`;
    case 'area':
      return `<c:areaChart><c:grouping val="${GROUPING[chart.stacking ?? ''] ?? 'standard'}"/><c:varyColors val="0"/>${series}${axIds}</c:areaChart>`;
    case 'pie':
      return `<c:pieChart><c:varyColors val="1"/>${series}<c:firstSliceAng val="0"/></c:pieChart>`;
    case 'doughnut':
      return `<c:doughnutChart><c:varyColors val="1"/>${series}<c:firstSliceAng val="0"/><c:holeSize val="50"/></c:doughnutChart>`;
    case 'scatter':
      return `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${series}${axIds}</c:scatterChart>`;
  }
}

function seriesXml(
  chart: Chart,
  s: ChartSeries,
  i: number,
  sheetName: string,
  labels: string[],
  values: (number | null)[],
  x: (number | null)[] | undefined,
  color: string,
  name: string,
): string {
  const ref = (f: string) => esc(qualified(f, sheetName));
  let tx = '';
  if (s.name && isReference(s.name)) tx = `<c:tx><c:strRef><c:f>${ref(s.name)}</c:f>${strCache([name])}</c:strRef></c:tx>`;
  else if (s.name) tx = `<c:tx><c:v>${esc(name)}</c:v></c:tx>`;
  const fill = `<a:solidFill><a:srgbClr val="${hex(color)}"/></a:solidFill>`;
  const lineLike = chart.type === 'line' || chart.type === 'scatter';
  const spPr = lineLike ? `<c:spPr><a:ln w="28575" cap="rnd">${fill}<a:round/></a:ln></c:spPr>` : `<c:spPr>${fill}</c:spPr>`;
  const head = `<c:idx val="${i}"/><c:order val="${i}"/>${tx}${chart.type === 'pie' || chart.type === 'doughnut' ? '' : spPr}`;
  const val = `<c:numRef><c:f>${ref(s.values)}</c:f>${numCache(values)}</c:numRef>`;
  if (chart.type === 'scatter') {
    const xVal = s.x ? `<c:xVal><c:numRef><c:f>${ref(s.x)}</c:f>${numCache(x ?? [])}</c:numRef></c:xVal>` : '';
    return `<c:ser>${head}<c:marker><c:symbol val="circle"/><c:size val="5"/></c:marker>${xVal}<c:yVal>${val}</c:yVal><c:smooth val="0"/></c:ser>`;
  }
  const cat = chart.categories ? `<c:cat><c:strRef><c:f>${ref(chart.categories)}</c:f>${strCache(labels)}</c:strRef></c:cat>` : '';
  const marker = chart.type === 'line' ? '<c:marker><c:symbol val="none"/></c:marker>' : '';
  const invert = chart.type === 'column' || chart.type === 'bar' ? '<c:invertIfNegative val="0"/>' : '';
  const smooth = chart.type === 'line' ? '<c:smooth val="0"/>' : '';
  return `<c:ser>${head}${invert}${marker}${cat}<c:val>${val}</c:val>${smooth}</c:ser>`;
}

function isReference(text: string): boolean {
  try {
    const tokens = tokenize(text).filter((t) => t.type !== 'ws');
    return tokens.length === 1 && tokens[0]!.type === 'ref';
  } catch {
    return false;
  }
}

function strCache(texts: string[]): string {
  const pts = texts.map((t, i) => `<c:pt idx="${i}"><c:v>${esc(t)}</c:v></c:pt>`).join('');
  return `<c:strCache><c:ptCount val="${texts.length}"/>${pts}</c:strCache>`;
}

function numCache(values: (number | null)[]): string {
  const pts = values.flatMap((v, i) => (v === null ? [] : [`<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`])).join('');
  return `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${pts}</c:numCache>`;
}

function axesXml(chart: Chart): string {
  const horizontal = chart.type === 'bar';
  const catPos = horizontal ? 'l' : 'b';
  const valPos = horizontal ? 'b' : 'l';
  const title = (text: string | undefined) => (text ? titleXml(text) : '');
  const common = (id: number, pos: string, cross: number, extra: string, text: string | undefined) =>
    `<c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${pos}"/>${extra}${title(text)}<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="${cross}"/><c:crosses val="autoZero"/>`;
  const valAx = `<c:valAx>${common(VAL_AX, valPos, CAT_AX, '<c:majorGridlines/>', chart.yTitle)}<c:crossBetween val="between"/></c:valAx>`;
  if (chart.type === 'scatter') {
    // Both axes hold numbers.
    return `<c:valAx>${common(CAT_AX, 'b', VAL_AX, '', chart.xTitle)}<c:crossBetween val="midCat"/></c:valAx>${valAx}`;
  }
  const catAx = `<c:catAx>${common(CAT_AX, catPos, VAL_AX, '', chart.xTitle)}<c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`;
  return catAx + valAx;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const CHART_ELEMENTS: Record<string, ChartType> = {
  barChart: 'column',
  bar3DChart: 'column',
  lineChart: 'line',
  line3DChart: 'line',
  areaChart: 'area',
  area3DChart: 'area',
  pieChart: 'pie',
  pie3DChart: 'pie',
  doughnutChart: 'doughnut',
  scatterChart: 'scatter',
};

export interface ChartPart {
  /** The anchor element (twoCellAnchor or oneCellAnchor) holding the chart. */
  anchor: XmlElement;
  /** The chart part's root, or null when it could not be read. */
  chart: XmlElement | null;
}

/** The charts of a drawing part, with what else it holds noted as a warning. */
export async function readDrawingCharts(
  zip: ZipReader,
  drawingPath: string,
  relsOf: (path: string) => Promise<{ id: string; type: string; target: string }[] | null>,
  warnings: Set<ImportWarning>,
): Promise<ChartPart[]> {
  const xml = await zip.readText(drawingPath);
  if (xml === null) return [];
  const root = parseXml(xml);
  const rels = (await relsOf(drawingPath)) ?? [];
  const out: ChartPart[] = [];
  for (const anchor of root.children) {
    if (anchor.name !== 'twoCellAnchor' && anchor.name !== 'oneCellAnchor') {
      warnings.add('drawings');
      continue;
    }
    const id = child(child(child(child(anchor, 'graphicFrame'), 'graphic'), 'graphicData'), 'chart')?.attrs.id;
    const rel = id ? rels.find((r) => r.id === id && r.type.endsWith('/chart')) : undefined;
    if (!rel) {
      warnings.add('drawings');
      continue;
    }
    const chartXmlText = await zip.readText(rel.target);
    out.push({ anchor, chart: chartXmlText === null ? null : parseXml(chartXmlText) });
  }
  return out;
}

/** A chart part as a WeldSheets chart placed on `sheet`; null (with a warning) for a kind WeldSheets does not draw. */
export function chartFromPart(part: ChartPart, sheet: SheetSnapshot, id: string, theme: string[], warnings: Set<ImportWarning>): Chart | null {
  const plot = child(child(part.chart ?? undefined, 'chart'), 'plotArea');
  const kind = plot?.children.find((c) => c.name in CHART_ELEMENTS);
  const placed = placement(part.anchor, sheet);
  if (!plot || !kind || !placed) {
    warnings.add('drawings');
    return null;
  }
  let type = CHART_ELEMENTS[kind.name]!;
  if (type === 'column' && child(kind, 'barDir')?.attrs.val === 'bar') type = 'bar';
  const series = childrenOf(kind, 'ser').map((s) => readSeries(s, type, theme));
  const valid = series.filter((s): s is ChartSeries => s !== null);
  if (valid.length === 0) {
    warnings.add('drawings');
    return null;
  }
  const chart: Chart = { id, type, series: valid, ...placed };
  const categories = childrenOf(kind, 'ser').map((s) => refOf(child(s, 'cat'))).find((c) => c);
  if (categories && type !== 'scatter') chart.categories = categories;
  const grouping = child(kind, 'grouping')?.attrs.val;
  if (grouping === 'stacked') chart.stacking = 'stacked';
  if (grouping === 'percentStacked') chart.stacking = 'percent';
  const chartEl = child(part.chart ?? undefined, 'chart');
  const title = textOf(child(chartEl, 'title'));
  if (title) chart.title = title;
  chart.legend = legendOf(child(chartEl, 'legend'));
  const axes = plot.children.filter((c) => c.name === 'catAx' || c.name === 'valAx' || c.name === 'dateAx');
  const xTitle = textOf(child(axes[0], 'title'));
  const yTitle = textOf(child(axes[1], 'title'));
  if (xTitle) chart.xTitle = xTitle;
  if (yTitle) chart.yTitle = yTitle;
  return chart;
}

function readSeries(ser: XmlElement, type: ChartType, theme: string[]): ChartSeries | null {
  const values = refOf(child(ser, type === 'scatter' ? 'yVal' : 'val'));
  if (!values) return null;
  const s: ChartSeries = { values };
  const tx = child(ser, 'tx');
  const nameRef = child(child(tx, 'strRef'), 'f')?.text;
  const literal = child(tx, 'v')?.text;
  const name = nameRef ? fromExcelFormula(nameRef) : null;
  if (name) s.name = name;
  else if (literal) s.name = `"${literal.replaceAll('"', '""')}"`;
  if (type === 'scatter') {
    const x = refOf(child(ser, 'xVal'));
    if (x) s.x = x;
  }
  const spPr = child(ser, 'spPr');
  const fill = child(child(spPr, 'solidFill'), 'srgbClr') ?? child(child(child(spPr, 'ln'), 'solidFill'), 'srgbClr');
  const color = fill?.attrs.val ? resolveColor({ name: 'color', attrs: { rgb: fill.attrs.val }, children: [], text: '' }, theme) : undefined;
  if (color) s.color = color;
  return s;
}

/** The formula of a `cat`, `val`, `xVal` or `yVal` (a string or number reference). */
function refOf(el: XmlElement | undefined): string | undefined {
  const f = child(child(el, 'numRef'), 'f')?.text ?? child(child(el, 'strRef'), 'f')?.text;
  return f ? (fromExcelFormula(f) ?? undefined) : undefined;
}

/** The text of a title: its rich text runs, or a cached value. */
function textOf(title: XmlElement | undefined): string {
  if (!title) return '';
  const tx = child(title, 'tx');
  const rich = child(tx, 'rich');
  if (rich) {
    return childrenOf(rich, 'p')
      .map((p) => childrenOf(p, 'r').map((r) => child(r, 't')?.text ?? '').join(''))
      .join(' ')
      .trim();
  }
  return child(child(child(child(tx, 'strRef'), 'strCache'), 'pt'), 'v')?.text ?? '';
}

function legendOf(el: XmlElement | undefined): Chart['legend'] {
  if (!el) return 'none';
  const pos = child(el, 'legendPos')?.attrs.val;
  if (pos === 't') return 'top';
  if (pos === 'r' || pos === 'l' || pos === 'tr') return 'right';
  return 'bottom';
}

/** Anchor and size from a drawing anchor, in pixels, using the sheet's column widths and row heights. */
function placement(anchor: XmlElement, sheet: SheetSnapshot): Pick<Chart, 'anchor' | 'width' | 'height'> | null {
  const from = child(anchor, 'from');
  if (!from) return null;
  const num = (el: XmlElement | undefined, name: string) => Number(child(el, name)?.text ?? 0);
  const col = num(from, 'col');
  const row = num(from, 'row');
  if (!(col >= 0 && row >= 0)) return null;
  const dx = Math.round(num(from, 'colOff') / EMU);
  const dy = Math.round(num(from, 'rowOff') / EMU);
  const cols = AxisDims.fromJSON(sheet.cols);
  const rows = AxisDims.fromJSON(sheet.rows);
  let width: number;
  let height: number;
  const to = child(anchor, 'to');
  if (to) {
    width = cols.offsetOf(num(to, 'col')) + num(to, 'colOff') / EMU - (cols.offsetOf(col) + dx);
    height = rows.offsetOf(num(to, 'row')) + num(to, 'rowOff') / EMU - (rows.offsetOf(row) + dy);
  } else {
    const ext = child(anchor, 'ext');
    width = Number(ext?.attrs.cx ?? 0) / EMU;
    height = Number(ext?.attrs.cy ?? 0) / EMU;
  }
  const size = (n: number) => Math.min(4000, Math.max(40, Math.round(n)));
  return { anchor: { row, col, dx: Math.max(0, dx), dy: Math.max(0, dy) }, width: size(width), height: size(height) };
}
