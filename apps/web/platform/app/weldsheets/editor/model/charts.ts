/**
 * Chart commands of the editor: insert a chart for the selected cells, save
 * one after an edit (in the panel, or moved and resized on the grid), remove
 * one. Each is one `patchCharts` op, so it co-edits and undoes.
 */

import {
  chartData,
  guessChartSource,
  resolveRef,
  seriesFromRange,
  type Chart,
  type ChartSource,
  type ChartType,
  type Range,
  type RangeAt,
} from '@weldsuite/sheets-engine';
import { referenceText } from './formula-edit';
import { currentRegion } from './rules';
import { clampToGrid, primaryRange } from './selection';
import type { SheetController } from './sheet-controller';

const DEFAULT_WIDTH = 480;
const DEFAULT_HEIGHT = 300;

export function newChartId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `ch_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** The cells a new chart draws: the selection, or the block of data around a single selected cell. */
export function chartRange(ctl: SheetController): Range {
  const sheet = ctl.sheet;
  const sel = clampToGrid(primaryRange(ctl.selection), sheet.rowCount, sheet.colCount);
  return sel.r1 === sel.r2 && sel.c1 === sel.c2 ? currentRegion(ctl, sel.r1, sel.c1) : sel;
}

/** A column chart (a line chart over dates) of the selected cells, placed beside them, and picked. */
export function insertChart(ctl: SheetController): Chart | null {
  if (ctl.readOnly) return null;
  const range = chartRange(ctl);
  const source = guessChartSource(ctl.engine, ctl.activeSheetId, range);
  const data = seriesFromRange(ctl.engine, ctl.activeSheetId, range, source);
  const sheet = ctl.sheet;
  const chart: Chart = {
    id: newChartId(),
    type: overDates(ctl, data.categories) ? 'line' : 'column',
    ...data,
    legend: 'bottom',
    anchor: { row: range.r1, col: Math.min(range.c2 + 2, sheet.colCount - 1), dx: 0, dy: 0 },
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  };
  ctl.apply({ type: 'patchCharts', sheetId: ctl.activeSheetId, set: [chart] });
  ctl.selectChart(chart.id);
  ctl.openPanel('chart');
  return chart;
}

/** Categories that are dates read best as a line. */
function overDates(ctl: SheetController, categories: string | undefined): boolean {
  if (!categories) return false;
  const probe: Chart = { id: '', type: 'line', categories, series: [], anchor: { row: 0, col: 0, dx: 0, dy: 0 }, width: 1, height: 1 };
  const format = chartData(ctl.engine, ctl.activeSheetId, probe).categoryFormat;
  return !!format && /[dmy]/i.test(format) && !/[#0]/.test(format);
}

export function saveChart(ctl: SheetController, chart: Chart): void {
  ctl.apply({ type: 'patchCharts', sheetId: ctl.activeSheetId, set: [chart] });
}

export function removeChart(ctl: SheetController, id: string): void {
  ctl.apply({ type: 'patchCharts', sheetId: ctl.activeSheetId, remove: [id] });
  if (ctl.selectedChart === id) ctl.selectChart(null);
}

/** The chart reading the cells at `at` as `source` says; series keep their colours by position. */
export function withRange(ctl: SheetController, chart: Chart, at: RangeAt, source: ChartSource): Chart {
  const data = seriesFromRange(ctl.engine, at.sheetId, at.range, source);
  const series = data.series.map((s, i) => (chart.series[i]?.color ? { ...s, color: chart.series[i]!.color } : s));
  const next: Chart = { ...chart, series };
  if (data.categories) next.categories = data.categories;
  else delete next.categories;
  return next;
}

/** A data range as the panel shows it: sheet-qualified only when it is on another sheet. */
export function rangeLabel(ctl: SheetController, at: RangeAt): string {
  const active = ctl.sheet.name;
  return referenceText(at.range, ctl.engine.sheetName(at.sheetId) ?? active, active);
}

/** A typed data range (A1:C10, 'Sales'!A1:C10); null when it is not one. */
export function parseDataRange(ctl: SheetController, text: string): RangeAt | null {
  const clean = text.trim().replace(/^=/, '');
  return clean ? resolveRef(ctl.engine, clean, ctl.activeSheetId) : null;
}

// ---------------------------------------------------------------------------
// Chart types as the panel offers them: a type with its stacking.
// ---------------------------------------------------------------------------

export const CHART_VARIANTS = [
  'column',
  'stackedColumn',
  'percentColumn',
  'bar',
  'stackedBar',
  'percentBar',
  'line',
  'area',
  'stackedArea',
  'percentArea',
  'pie',
  'doughnut',
  'scatter',
] as const;
export type ChartVariant = (typeof CHART_VARIANTS)[number];

const VARIANTS: Record<ChartVariant, { type: ChartType; stacking?: Chart['stacking'] }> = {
  column: { type: 'column' },
  stackedColumn: { type: 'column', stacking: 'stacked' },
  percentColumn: { type: 'column', stacking: 'percent' },
  bar: { type: 'bar' },
  stackedBar: { type: 'bar', stacking: 'stacked' },
  percentBar: { type: 'bar', stacking: 'percent' },
  line: { type: 'line' },
  area: { type: 'area' },
  stackedArea: { type: 'area', stacking: 'stacked' },
  percentArea: { type: 'area', stacking: 'percent' },
  pie: { type: 'pie' },
  doughnut: { type: 'doughnut' },
  scatter: { type: 'scatter' },
};

export function variantOf(chart: Chart): ChartVariant {
  return CHART_VARIANTS.find((v) => VARIANTS[v].type === chart.type && VARIANTS[v].stacking === chart.stacking) ?? chart.type;
}

export function withVariant(chart: Chart, variant: ChartVariant): Chart {
  const { type, stacking } = VARIANTS[variant];
  const next: Chart = { ...chart, type };
  if (stacking) next.stacking = stacking;
  else delete next.stacking;
  return next;
}
