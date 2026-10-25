/**
 * Charts: plain data on a sheet, like its rules (model/rules.ts). A chart is
 * anchored to a cell with an offset and has a size in pixels; its data is
 * given as references written as formula text ('Sales'!$B$2:$B$13), so row,
 * column and sheet changes rewrite them like any formula. Charts travel in
 * snapshots and in `patchCharts` ops, and are drawn by the editor.
 */

export type ChartType = 'column' | 'bar' | 'line' | 'area' | 'pie' | 'doughnut' | 'scatter';

export const CHART_TYPES: readonly ChartType[] = ['column', 'bar', 'line', 'area', 'pie', 'doughnut', 'scatter'];

export interface ChartSeries {
  /** Formula text of the series name: a cell ('Sales'!$B$1) or a quoted text ("Revenue"). */
  name?: string;
  /** Formula text of the values: a one-row or one-column range. */
  values: string;
  /** Scatter only: the x values (a range like `values`). */
  x?: string;
  /** #rrggbb; the chart's palette when left out. */
  color?: string;
}

/** Where a chart's top-left corner is: a cell, and pixels into it. */
export interface ChartAnchor {
  row: number;
  col: number;
  dx: number;
  dy: number;
}

export interface Chart {
  id: string;
  type: ChartType;
  /** Column, bar and area charts: stacked, or stacked to 100%. */
  stacking?: 'stacked' | 'percent';
  /** Formula text of the category labels (the x axis, or the slices of a pie). */
  categories?: string;
  series: ChartSeries[];
  title?: string;
  /** Where the legend goes (default 'bottom'). */
  legend?: 'right' | 'bottom' | 'top' | 'none';
  xTitle?: string;
  yTitle?: string;
  anchor: ChartAnchor;
  width: number;
  height: number;
}

export const MIN_CHART_SIZE = 40;
export const MAX_CHART_SIZE = 4000;
export const MAX_CHART_SERIES = 50;

/** The default palette, in the order series take it. */
export const CHART_PALETTE = [
  '#4285f4',
  '#ea4335',
  '#fbbc04',
  '#34a853',
  '#ff6d01',
  '#46bdc6',
  '#7baaf7',
  '#f07b72',
  '#fcd04f',
  '#71c287',
];

export function cloneChart(c: Chart): Chart {
  return structuredClone(c);
}

/** Applies `fn` to every reference a chart holds. */
export function mapChartFormulas(c: Chart, fn: (formula: string) => string): Chart {
  return {
    ...c,
    ...(c.categories === undefined ? {} : { categories: fn(c.categories) }),
    series: c.series.map((s) => ({
      ...s,
      values: fn(s.values),
      ...(s.name === undefined ? {} : { name: fn(s.name) }),
      ...(s.x === undefined ? {} : { x: fn(s.x) }),
    })),
  };
}

/**
 * An anchor after its sheet's rows or columns moved: `mapIndex` gives each
 * old index its new one, or -1 for a deleted one. A chart whose anchor row or
 * column went stays where the deletion was, at the start of the next one.
 */
export function anchorAfter(anchor: ChartAnchor, axis: 'row' | 'col', mapIndex: (i: number) => number, max: number): ChartAnchor {
  const key = axis === 'row' ? 'row' : 'col';
  const offset = axis === 'row' ? 'dy' : 'dx';
  const mapped = mapIndex(anchor[key]);
  if (mapped >= 0) return { ...anchor, [key]: Math.min(mapped, max - 1) };
  let next = anchor[key] + 1;
  while (next < max && mapIndex(next) < 0) next++;
  const landed = next < max ? mapIndex(next) : max - 1;
  return { ...anchor, [key]: Math.max(0, Math.min(landed, max - 1)), [offset]: 0 };
}
