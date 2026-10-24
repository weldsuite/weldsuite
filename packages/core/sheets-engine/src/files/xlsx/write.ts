/**
 * Writing a workbook as .xlsx, from a calculated engine: every sheet with
 * its values and formulas (with the values WeldSheets computed, so readers
 * that do not calculate still show them), styles, sizes, hidden rows and
 * columns, merges, frozen panes, the filter, conditional formats, data
 * validation and defined names.
 *
 * A formula that spills is written as a dynamic array (an array formula
 * marked with the cell metadata Excel 365 uses), so Excel spills it too
 * instead of reading it as a legacy single-cell formula. The workbook asks
 * Excel to recalculate everything on load.
 */

import { MAX_COLS, cellKey, colToLetters, formatA1, quoteSheetName, type Range } from '../../address';
import type { Engine } from '../../calc/engine';
import { EN_LOCALE, formatValue, type FormatLocale } from '../../format/number-format';
import type { AxisSnapshot } from '../../model/axis';
import { valueKey, sortFormats, type ColorPoint, type ConditionalFormat, type DataValidation, type FilterColumn, type SheetFilter } from '../../model/rules';
import type { Sheet } from '../../model/workbook';
import { isError, type Scalar } from '../../values';
import { isPivotFormula } from '../../pivot/pivot';
import { XML_HEADER, attrs, esc, escCellText } from '../xml';
import { writeZip, type ZipFile } from '../zip';
import { CT_CHART, CT_DRAWING, writeDrawing } from './charts';
import { toArgb } from './colors';
import { cellIsForm, conditionFormula, pxToPoints, pxToWidth, quote } from './conditions';
import { toExcelFormula } from './formulas';
import { StylesWriter } from './styles';

export interface WriteXlsxOptions {
  /** Shown as the file's creation and modification time (default now). */
  date?: Date;
  /** How values are shown in the filter's value lists (default English). */
  locale?: FormatLocale;
}

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL_TYPE = `${NS_REL}/`;
const CT_PREFIX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.';
/** Excel caps a literal validation list at 255 characters. */
const MAX_LIST_FORMULA = 255;

interface Context {
  engine: Engine;
  styles: StylesWriter;
  strings: SharedStrings;
  locale: FormatLocale;
  /** Set when a sheet holds a spilling formula (the workbook then needs its metadata part). */
  dynamic: boolean;
}

export async function writeXlsx(engine: Engine, options: WriteXlsxOptions = {}): Promise<Uint8Array> {
  const ctx: Context = { engine, styles: new StylesWriter(), strings: new SharedStrings(), locale: options.locale ?? EN_LOCALE, dynamic: false };
  const sheets = engine.workbook.sheets;
  const active = Math.max(0, sheets.findIndex((s) => !s.props.hidden));
  const sheetParts = sheets.map((sheet, i) => writeSheet(sheet, i === active, ctx));
  const date = options.date ?? new Date();

  // Each sheet with charts gets a drawing; chart parts are numbered across the workbook.
  const drawingFiles: ZipFile[] = [];
  const overrides: [string, string][] = [];
  let drawings = 0;
  let chartCount = 0;
  sheets.forEach((sheet, i) => {
    if (!sheet.charts.length) return;
    const n = ++drawings;
    const parts = writeDrawing(engine, sheet, chartCount + 1, ctx.locale);
    sheetParts[i] = sheetParts[i]!.replace('</worksheet>', '<drawing r:id="rId1"/></worksheet>');
    drawingFiles.push(
      { name: `xl/worksheets/_rels/sheet${i + 1}.xml.rels`, data: relsXml([[`${REL_TYPE}drawing`, `../drawings/drawing${n}.xml`]]) },
      { name: `xl/drawings/drawing${n}.xml`, data: parts.drawing },
      { name: `xl/drawings/_rels/drawing${n}.xml.rels`, data: parts.rels },
      ...parts.charts.map((data, k) => ({ name: `xl/charts/chart${chartCount + 1 + k}.xml`, data })),
    );
    overrides.push([`/xl/drawings/drawing${n}.xml`, CT_DRAWING], ...parts.charts.map((_, k): [string, string] => [`/xl/charts/chart${chartCount + 1 + k}.xml`, CT_CHART]));
    chartCount += parts.charts.length;
  });

  const files = [
    { name: '[Content_Types].xml', data: contentTypes(sheets.length, ctx.dynamic, overrides) },
    { name: '_rels/.rels', data: rootRels() },
    { name: 'docProps/core.xml', data: coreProps(date) },
    { name: 'docProps/app.xml', data: `${XML_HEADER}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>WeldSheets</Application></Properties>` },
    { name: 'xl/workbook.xml', data: workbookXml(engine, active) },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels(sheets.length, ctx.dynamic) },
    ...sheetParts.map((data, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data })),
    { name: 'xl/styles.xml', data: XML_HEADER + ctx.styles.toXml() },
    { name: 'xl/sharedStrings.xml', data: ctx.strings.toXml() },
    ...(ctx.dynamic ? [{ name: 'xl/metadata.xml', data: METADATA }] : []),
    ...drawingFiles,
  ];
  return writeZip(files, { date });
}

class SharedStrings {
  private readonly index = new Map<string, number>();
  private count = 0;

  add(text: string): number {
    this.count++;
    let i = this.index.get(text);
    if (i === undefined) {
      i = this.index.size;
      this.index.set(text, i);
    }
    return i;
  }

  toXml(): string {
    const items = [...this.index.keys()].map((t) => `<si><t xml:space="preserve">${escCellText(t)}</t></si>`);
    return `${XML_HEADER}<sst xmlns="${NS_MAIN}" count="${this.count}" uniqueCount="${items.length}">${items.join('')}</sst>`;
  }
}

// ---------------------------------------------------------------------------
// Worksheet
// ---------------------------------------------------------------------------

interface OutCell {
  formula?: string;
  value: Scalar;
  xf: number;
  /** The area a dynamic array formula fills. */
  spill?: Range;
}

function writeSheet(sheet: Sheet, selected: boolean, ctx: Context): string {
  const cells = collectCells(sheet, ctx);
  const filtered = filteredRows(sheet);
  const rows = sheet.rows.toJSON();
  const used = usedArea(cells);
  const props = sheet.props;

  const tab = toArgb(props.tabColor);
  const tabColor = tab ? `<tabColor rgb="${tab}"/>` : '';
  const sheetPr = tab || filtered.size ? `<sheetPr${attrs({ filterMode: filtered.size > 0 })}>${tabColor}</sheetPr>` : '';
  const merges = sheet.merges.map((m) => `<mergeCell ref="${rangeA1(m)}"/>`).join('');
  const view = `<sheetViews><sheetView${attrs({
    showGridLines: props.gridlines === false ? '0' : undefined,
    rightToLeft: props.rtl,
    tabSelected: selected,
    workbookViewId: 0,
  })}>${paneXml(sheet)}</sheetView></sheetViews>`;
  const format = `<sheetFormatPr${attrs({ defaultColWidth: pxToWidth(sheet.cols.defaultSize), defaultRowHeight: pxToPoints(rows.defaultSize), customHeight: true })}/>`;

  return [
    `${XML_HEADER}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`,
    sheetPr,
    `<dimension ref="${used ? rangeA1(used) : 'A1'}"/>`,
    view,
    format,
    colsXml(sheet.cols.toJSON(), ctx),
    sheetDataXml(cells, rows, filtered, ctx),
    sheet.filter ? autoFilterXml(sheet, sheet.filter, ctx) : '',
    merges ? `<mergeCells count="${sheet.merges.length}">${merges}</mergeCells>` : '',
    conditionalFormatsXml(sheet.conditionalFormats, ctx),
    validationsXml(sheet.validations),
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>',
    '</worksheet>',
  ].join('');
}

/**
 * Stored cells with their computed values, plus the cells spilled formulas
 * fill. A cell carries its whole look (its row's or column's style when it
 * has none of its own): Excel gives row and column styles only to new cells.
 */
function collectCells(sheet: Sheet, ctx: Context): Map<number, OutCell> {
  const { engine, styles } = ctx;
  const out = new Map<number, OutCell>();
  const book = engine.workbook;
  const spills: Range[] = [];
  sheet.cells.forEach((row, col, cell) => {
    const xf = styles.xf(book.style(sheet, row, col));
    if (cell.f === undefined) {
      out.set(cellKey(row, col), { value: cell.v, xf });
      return;
    }
    // Excel has no PIVOT function: a pivot table goes as the values it shows.
    const pivot = isPivotFormula(cell.f);
    const value = engine.getValue(sheet.id, row, col);
    const entry: OutCell = pivot ? { value, xf } : { formula: cell.f, value, xf };
    const spill = engine.spillArea(sheet.id, row, col);
    if (spill && (spill.r2 > spill.r1 || spill.c2 > spill.c1)) {
      spills.push(spill);
      if (!pivot) {
        entry.spill = spill;
        ctx.dynamic = true;
      }
    }
    out.set(cellKey(row, col), entry);
  });
  for (const spill of spills) {
    for (let r = spill.r1; r <= spill.r2; r++) {
      for (let c = spill.c1; c <= spill.c2; c++) {
        const key = cellKey(r, c);
        if (!out.has(key)) out.set(key, { value: engine.getValue(sheet.id, r, c), xf: styles.xf(book.style(sheet, r, c)) });
      }
    }
  }
  return out;
}

/** Rows the sheet's filter hides now; they are saved hidden, as Excel saves them. */
function filteredRows(sheet: Sheet): Set<number> {
  const out = new Set<number>();
  const f = sheet.filter;
  if (!f) return out;
  const last = Math.min(f.range.r2, sheet.rowCount - 1);
  for (let row = f.range.r1 + 1; row <= last; row++) if (sheet.rows.isFiltered(row)) out.add(row);
  return out;
}

function usedArea(cells: Map<number, OutCell>): Range | null {
  if (cells.size === 0) return null;
  let r1 = Infinity;
  let c1 = Infinity;
  let r2 = -1;
  let c2 = -1;
  for (const key of cells.keys()) {
    const row = Math.floor(key / MAX_COLS);
    const col = key % MAX_COLS;
    r1 = Math.min(r1, row);
    r2 = Math.max(r2, row);
    c1 = Math.min(c1, col);
    c2 = Math.max(c2, col);
  }
  return { r1, c1, r2, c2 };
}

function paneXml(sheet: Sheet): string {
  const { rows, cols } = sheet.freeze;
  if (!rows && !cols) return '';
  let pane = 'bottomRight';
  if (!cols) pane = 'bottomLeft';
  else if (!rows) pane = 'topRight';
  return `<pane${attrs({ xSplit: cols || undefined, ySplit: rows || undefined, topLeftCell: formatA1(rows, cols), activePane: pane, state: 'frozen' })}/><selection pane="${pane}"/>`;
}

/** Column widths, hidden columns and column styles, as runs of equal columns. */
function colsXml(cols: AxisSnapshot, ctx: Context): string {
  const sizes = new Map(cols.sizes ?? []);
  const hidden = new Set(cols.hidden ?? []);
  const styles = new Map(cols.styles ?? []);
  const indices = [...new Set([...sizes.keys(), ...hidden, ...styles.keys()])].sort((a, b) => a - b);
  if (indices.length === 0) return '';
  const describe = (i: number) => {
    const size = sizes.get(i);
    const style = styles.get(i);
    return attrs({
      width: pxToWidth(size ?? cols.defaultSize),
      style: style ? ctx.styles.xf(ctx.engine.workbook.styles.get(style)) || undefined : undefined,
      hidden: hidden.has(i),
      customWidth: size !== undefined,
    });
  };
  const out: string[] = [];
  let start = indices[0]!;
  let prev = start;
  let current = describe(start);
  for (const i of indices.slice(1)) {
    const d = describe(i);
    if (i === prev + 1 && d === current) {
      prev = i;
      continue;
    }
    out.push(`<col min="${start + 1}" max="${prev + 1}"${current}/>`);
    [start, prev, current] = [i, i, d];
  }
  out.push(`<col min="${start + 1}" max="${prev + 1}"${current}/>`);
  return `<cols>${out.join('')}</cols>`;
}

function sheetDataXml(cells: Map<number, OutCell>, rows: AxisSnapshot, filtered: Set<number>, ctx: Context): string {
  const byRow = new Map<number, [number, OutCell][]>();
  for (const [key, cell] of cells) {
    const row = Math.floor(key / MAX_COLS);
    const list = byRow.get(row);
    if (list) list.push([key % MAX_COLS, cell]);
    else byRow.set(row, [[key % MAX_COLS, cell]]);
  }
  const sizes = new Map(rows.sizes ?? []);
  const hidden = new Set([...(rows.hidden ?? []), ...filtered]);
  const styles = new Map(rows.styles ?? []);
  const indices = [...new Set([...byRow.keys(), ...sizes.keys(), ...hidden, ...styles.keys()])].sort((a, b) => a - b);

  const out: string[] = ['<sheetData>'];
  for (const row of indices) {
    const size = sizes.get(row);
    const style = styles.get(row);
    const xf = style ? ctx.styles.xf(ctx.engine.workbook.styles.get(style)) : 0;
    const head = `<row${attrs({ r: row + 1, s: xf || undefined, customFormat: xf > 0, ht: size === undefined ? undefined : pxToPoints(size), customHeight: size !== undefined, hidden: hidden.has(row) })}`;
    const list = byRow.get(row);
    if (!list) {
      out.push(`${head}/>`);
      continue;
    }
    list.sort((a, b) => a[0] - b[0]);
    out.push(`${head}>${list.map(([col, cell]) => cellXml(row, col, cell, ctx)).join('')}</row>`);
  }
  out.push('</sheetData>');
  return out.join('');
}

/** A value as a cell's type (`t`) and `v` text. Text goes to the shared strings, except a formula's result. */
function encodeValue(value: Scalar, isFormula: boolean, ctx: Context): { type?: string; v: string | null } {
  if (typeof value === 'number') return { v: Number.isFinite(value) ? String(value) : null };
  if (typeof value === 'boolean') return { type: 'b', v: value ? '1' : '0' };
  if (isError(value)) return { type: 'e', v: value.code };
  if (typeof value !== 'string') return { v: null };
  return isFormula ? { type: 'str', v: escCellText(value) } : { type: 's', v: String(ctx.strings.add(value)) };
}

function cellXml(row: number, col: number, cell: OutCell, ctx: Context): string {
  const { type, v } = encodeValue(cell.value, cell.formula !== undefined, ctx);
  const a = attrs({ r: formatA1(row, col), s: cell.xf || undefined, t: type, cm: cell.spill ? 1 : undefined });
  let f = '';
  if (cell.formula !== undefined) {
    const text = esc(toExcelFormula(cell.formula));
    f = cell.spill ? `<f t="array" ref="${rangeA1(cell.spill)}">${text}</f>` : `<f>${text}</f>`;
  }
  const body = f + (v === null ? '' : `<v>${v}</v>`);
  return body ? `<c${a}>${body}</c>` : `<c${a}/>`;
}

function rangeA1(r: Range): string {
  return r.r1 === r.r2 && r.c1 === r.c2 ? formatA1(r.r1, r.c1) : `${formatA1(r.r1, r.c1)}:${formatA1(r.r2, r.c2)}`;
}

function absRange(sheetName: string, r: Range): string {
  return `${quoteSheetName(sheetName)}!$${colToLetters(r.c1)}$${r.r1 + 1}:$${colToLetters(r.c2)}$${r.r2 + 1}`;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function autoFilterXml(sheet: Sheet, filter: SheetFilter, ctx: Context): string {
  const columns = filter.columns.map((c) => filterColumnXml(sheet, filter, c, ctx)).filter(Boolean);
  return `<autoFilter ref="${rangeA1(filter.range)}">${columns.join('')}</autoFilter>`;
}

function filterColumnXml(sheet: Sheet, filter: SheetFilter, column: FilterColumn, ctx: Context): string {
  const colId = column.col - filter.range.c1;
  if (column.hiddenValues?.length) {
    const hidden = new Set(column.hiddenValues);
    const shown = new Set<string>();
    let blanks = false;
    const last = Math.min(filter.range.r2, sheet.rowCount - 1);
    for (let row = filter.range.r1 + 1; row <= last; row++) {
      const value = ctx.engine.getValue(sheet.id, row, column.col);
      const key = valueKey(value);
      if (hidden.has(key)) continue;
      if (key === '') blanks = true;
      else shown.add(formatValue(value, ctx.engine.workbook.style(sheet, row, column.col)?.numFmt, ctx.locale).text);
    }
    const items = [...shown].map((t) => `<filter val="${esc(t)}"/>`).join('');
    return `<filterColumn colId="${colId}"><filters${attrs({ blank: blanks })}>${items}</filters></filterColumn>`;
  }
  const custom = column.condition ? customFiltersXml(column.condition) : null;
  return custom ? `<filterColumn colId="${colId}">${custom}</filterColumn>` : '';
}

function customFiltersXml(c: NonNullable<FilterColumn['condition']>): string | null {
  const filters = customFilters(c);
  if (!filters) return null;
  const items = filters.map(([operator, val]) => `<customFilter${attrs({ operator: operator === 'equal' ? undefined : operator, val: String(val) })}/>`);
  return `<customFilters${attrs({ and: c.type === 'between' })}>${items.join('')}</customFilters>`;
}

/** A filter condition as Excel's custom filters (operator, value); '*' is Excel's wildcard. */
function customFilters(c: NonNullable<FilterColumn['condition']>): [string, string | number][] | null {
  switch (c.type) {
    case 'textContains':
      return [['equal', '*' + c.value + '*']];
    case 'textNotContains':
      return [['notEqual', '*' + c.value + '*']];
    case 'textStartsWith':
      return [['equal', c.value + '*']];
    case 'textEndsWith':
      return [['equal', '*' + c.value]];
    case 'textIs':
      return [['equal', c.value]];
    case 'between':
      return [
        ['greaterThanOrEqual', c.min],
        ['lessThanOrEqual', c.max],
      ];
    case 'notBetween':
      return [
        ['lessThan', c.min],
        ['greaterThan', c.max],
      ];
    case 'empty':
    case 'notEmpty':
    case 'formula':
      return null;
    default: {
      const form = cellIsForm(c);
      return form ? [[form.operator, c.value]] : null;
    }
  }
}

function conditionalFormatsXml(formats: ConditionalFormat[], ctx: Context): string {
  return sortFormats(formats)
    .map((cf, i) => {
      const rule = cfRuleXml(cf, i + 1, ctx);
      return rule ? `<conditionalFormatting sqref="${cf.ranges.map(rangeA1).join(' ')}">${rule}</conditionalFormatting>` : '';
    })
    .join('');
}

const TEXT_RULE: Record<string, [string, string]> = {
  textContains: ['containsText', 'containsText'],
  textNotContains: ['notContainsText', 'notContains'],
  textStartsWith: ['beginsWith', 'beginsWith'],
  textEndsWith: ['endsWith', 'endsWith'],
};

function cfRuleXml(cf: ConditionalFormat, priority: number, ctx: Context): string | null {
  const anchor = formatA1(cf.ranges[0]!.r1, cf.ranges[0]!.c1);
  const rule = cf.rule;
  if (rule.type === 'colorScale') {
    const cfvos = rule.points.map(cfvoXml).join('');
    const colors = rule.points.map((p) => `<color rgb="${toArgb(p.color) ?? 'FF000000'}"/>`).join('');
    return `<cfRule type="colorScale" priority="${priority}"><colorScale>${cfvos}${colors}</colorScale></cfRule>`;
  }
  const c = rule.condition;
  const dxf = ctx.styles.dxf(rule.style);
  const formula = (f: string) => `<formula>${esc(toExcelFormula(f))}</formula>`;
  const text = TEXT_RULE[c.type];
  if (text && 'value' in c && typeof c.value === 'string') {
    return `<cfRule${attrs({ type: text[0], dxfId: dxf, priority, operator: text[1], text: c.value })}>${formula(conditionFormula(c, anchor))}</cfRule>`;
  }
  if (c.type === 'empty' || c.type === 'notEmpty') {
    return `<cfRule${attrs({ type: c.type === 'empty' ? 'containsBlanks' : 'notContainsBlanks', dxfId: dxf, priority })}>${formula(conditionFormula(c, anchor))}</cfRule>`;
  }
  const form = cellIsForm(c);
  if (form) {
    return `<cfRule${attrs({ type: 'cellIs', dxfId: dxf, priority, operator: form.operator })}>${form.operands.map(formula).join('')}</cfRule>`;
  }
  return `<cfRule${attrs({ type: 'expression', dxfId: dxf, priority })}>${formula(conditionFormula(c, anchor))}</cfRule>`;
}

const CFVO: Record<ColorPoint['kind'], string> = { min: 'min', max: 'max', number: 'num', percent: 'percent', percentile: 'percentile' };

function cfvoXml(p: ColorPoint): string {
  return `<cfvo${attrs({ type: CFVO[p.kind], val: p.kind === 'min' || p.kind === 'max' ? undefined : (p.value ?? 0) })}/>`;
}

function validationsXml(rules: DataValidation[]): string {
  const items = rules.map(validationXml).filter((x): x is string => x !== null);
  return items.length ? `<dataValidations count="${items.length}">${items.join('')}</dataValidations>` : '';
}

/**
 * The rule as Excel's validation type, operator and formulas; null for a
 * list Excel cannot hold (items with commas, or over 255 characters).
 */
function validationKind(dv: DataValidation): { type: string; operator?: string; formulas: string[] } | null {
  const c = dv.criteria;
  if (c.type === 'list' || c.type === 'checkbox') {
    const values = c.type === 'list' ? c.values : ['TRUE', 'FALSE'];
    const literal = quote(values.join(','));
    if (values.some((v) => v.includes(',')) || literal.length > MAX_LIST_FORMULA) return null;
    return { type: 'list', formulas: [literal] };
  }
  if (c.type === 'listRange') return { type: 'list', formulas: [toExcelFormula(c.source)] };
  const form = cellIsForm(c.condition);
  if (form && c.condition.type !== 'textIs') return { type: 'decimal', operator: form.operator, formulas: form.operands };
  const anchor = formatA1(dv.ranges[0]!.r1, dv.ranges[0]!.c1);
  return { type: 'custom', formulas: [toExcelFormula(conditionFormula(c.condition, anchor))] };
}

function validationXml(dv: DataValidation): string | null {
  const kind = validationKind(dv);
  if (!kind) return null;
  const { type, operator, formulas } = kind;
  const a = attrs({
    type,
    errorStyle: dv.strict ? undefined : 'warning',
    operator: operator === 'between' ? undefined : operator,
    allowBlank: true,
    showDropDown: type === 'list' && dv.dropdown === false,
    showInputMessage: !!dv.help,
    showErrorMessage: true,
    prompt: dv.help,
    sqref: dv.ranges.map(rangeA1).join(' '),
  });
  const [f1, f2] = formulas.map(esc);
  const second = f2 === undefined ? '' : `<formula2>${f2}</formula2>`;
  return `<dataValidation${a}><formula1>${f1}</formula1>${second}</dataValidation>`;
}

// ---------------------------------------------------------------------------
// Workbook and package parts
// ---------------------------------------------------------------------------

function workbookXml(engine: Engine, active: number): string {
  const sheets = engine.workbook.sheets;
  const sheetEls = sheets.map((s, i) => `<sheet${attrs({ name: s.name, sheetId: i + 1, state: s.props.hidden ? 'hidden' : undefined })} r:id="rId${i + 1}"/>`);
  const names: string[] = [];
  sheets.forEach((s, i) => {
    if (s.filter) names.push(`<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${esc(absRange(s.name, s.filter.range))}</definedName>`);
  });
  for (const n of engine.workbook.names) {
    const scope = n.sheetId === undefined ? -1 : sheets.findIndex((s) => s.id === n.sheetId);
    if (n.sheetId !== undefined && scope < 0) continue;
    names.push(`<definedName${attrs({ name: n.name, localSheetId: scope < 0 ? undefined : scope })}>${esc(toExcelFormula(n.formula))}</definedName>`);
  }
  return [
    `${XML_HEADER}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`,
    '<workbookPr/>',
    `<bookViews><workbookView activeTab="${active}"/></bookViews>`,
    `<sheets>${sheetEls.join('')}</sheets>`,
    names.length ? `<definedNames>${names.join('')}</definedNames>` : '',
    '<calcPr calcId="191029" fullCalcOnLoad="1"/>',
    '</workbook>',
  ].join('');
}

function contentTypes(sheetCount: number, dynamic: boolean, extra: [string, string][] = []): string {
  const override = (part: string, type: string) => `<Override PartName="${part}" ContentType="${type}"/>`;
  const sheets = Array.from({ length: sheetCount }, (_, i) => override(`/xl/worksheets/sheet${i + 1}.xml`, `${CT_PREFIX}worksheet+xml`));
  return [
    `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`,
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    override('/xl/workbook.xml', `${CT_PREFIX}sheet.main+xml`),
    ...sheets,
    override('/xl/styles.xml', `${CT_PREFIX}styles+xml`),
    override('/xl/sharedStrings.xml', `${CT_PREFIX}sharedStrings+xml`),
    dynamic ? override('/xl/metadata.xml', `${CT_PREFIX}sheetMetadata+xml`) : '',
    ...extra.map(([part, type]) => override(part, type)),
    override('/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'),
    override('/docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml'),
    '</Types>',
  ].join('');
}

function relsXml(rels: [string, string][]): string {
  const items = rels.map(([type, target], i) => `<Relationship Id="rId${i + 1}" Type="${type}" Target="${target}"/>`);
  return `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join('')}</Relationships>`;
}

function rootRels(): string {
  return relsXml([
    [`${REL_TYPE}officeDocument`, 'xl/workbook.xml'],
    ['http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', 'docProps/core.xml'],
    [`${REL_TYPE}extended-properties`, 'docProps/app.xml'],
  ]);
}

function workbookRels(sheetCount: number, dynamic: boolean): string {
  const rels: [string, string][] = Array.from({ length: sheetCount }, (_, i) => [`${REL_TYPE}worksheet`, `worksheets/sheet${i + 1}.xml`]);
  rels.push([`${REL_TYPE}styles`, 'styles.xml'], [`${REL_TYPE}sharedStrings`, 'sharedStrings.xml']);
  if (dynamic) rels.push([`${REL_TYPE}sheetMetadata`, 'metadata.xml']);
  return relsXml(rels);
}

function coreProps(date: Date): string {
  const when = `${date.toISOString().slice(0, 19)}Z`;
  return [
    `${XML_HEADER}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`,
    `<dcterms:created xsi:type="dcterms:W3CDTF">${when}</dcterms:created>`,
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${when}</dcterms:modified>`,
    '</cp:coreProperties>',
  ].join('');
}

/** Cell metadata that marks `cm="1"` formulas as dynamic arrays (Excel 365). */
const METADATA = `${XML_HEADER}<metadata xmlns="${NS_MAIN}" xmlns:xda="http://schemas.microsoft.com/office/spreadsheetml/2017/dynamicarray"><metadataTypes count="1"><metadataType name="XLDAPR" minSupportedVersion="120000" copy="1" pasteAll="1" pasteValues="1" merge="1" splitFirst="1" rowColShift="1" clearFormats="1" clearComments="1" assign="1" coerce="1" cellMeta="1"/></metadataTypes><futureMetadata name="XLDAPR" count="1"><bk><extLst><ext uri="{bdbb8cdc-fa1e-496e-a857-3c3f30c029c3}"><xda:dynamicArrayProperties fDynamic="1" fCollapsed="0"/></ext></extLst></bk></futureMetadata><cellMetadata count="1"><bk><rc t="1" v="0"/></bk></cellMetadata></metadata>`;
