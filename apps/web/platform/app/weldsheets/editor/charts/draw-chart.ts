/**
 * Drawing a chart on the grid canvas: title, legend, axes with "nice" tick
 * values, gridlines, and the marks (bars, lines, areas, slices, points).
 * Colours other than the series' come from the grid theme, so charts follow
 * dark mode like the cells do.
 */

import { CHART_PALETTE, type Chart, type ChartData, type Scalar } from '@weldsuite/sheets-engine';
import type { Rect } from '../grid/geometry';

export interface ChartPaint {
  background: string;
  text: string;
  muted: string;
  grid: string;
  border: string;
  /** A value as it shows in a cell with that number format. */
  format: (value: Scalar, numFmt: string | undefined) => string;
  /** Shown when there is nothing to plot. */
  emptyLabel: string;
}

const PAD = 12;
const FONT = '12px Arial';
const SMALL = '11px Arial';
const TITLE_FONT = 'bold 14px Arial';
const LINE = 16;

interface Series {
  name: string;
  color: string;
  values: (number | null)[];
  x?: (number | null)[];
  format?: string;
}

export function drawChart(ctx: CanvasRenderingContext2D, rect: Rect, chart: Chart, data: ChartData, paint: ChartPaint): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();
  ctx.fillStyle = paint.background;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.strokeStyle = paint.border;
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);

  let box: Rect = { x: rect.x + PAD, y: rect.y + PAD, w: rect.w - 2 * PAD, h: rect.h - 2 * PAD };
  if (chart.title) box = drawTitle(ctx, box, chart.title, paint);
  const series: Series[] = data.series.map((s) => ({ ...s }));
  const pie = chart.type === 'pie' || chart.type === 'doughnut';
  const labels = categoryLabels(data, series, paint);
  const legend = pie ? labels.map((label, i) => ({ label, color: CHART_PALETTE[i % CHART_PALETTE.length]! })) : series.map((s) => ({ label: s.name, color: s.color }));
  box = drawLegend(ctx, box, chart.legend ?? 'bottom', legend, paint);

  if (box.w > 20 && box.h > 20) {
    if (!series.some((s) => s.values.some((v) => v !== null))) drawEmpty(ctx, box, paint);
    else if (pie) drawPie(ctx, box, series[0]!, chart.type === 'doughnut', paint);
    else if (chart.type === 'scatter') drawScatter(ctx, box, chart, series, paint);
    else drawCartesian(ctx, box, chart, series, labels, paint);
  }
  ctx.restore();
}

function drawTitle(ctx: CanvasRenderingContext2D, box: Rect, title: string, paint: ChartPaint): Rect {
  ctx.font = TITLE_FONT;
  ctx.fillStyle = paint.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(fit(ctx, title, box.w), box.x + box.w / 2, box.y);
  return { ...box, y: box.y + 24, h: box.h - 24 };
}

function drawEmpty(ctx: CanvasRenderingContext2D, box: Rect, paint: ChartPaint): void {
  ctx.font = FONT;
  ctx.fillStyle = paint.muted;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(paint.emptyLabel, box.x + box.w / 2, box.y + box.h / 2);
}

/** Labels of the points: the categories as they show, else 1, 2, 3, … */
function categoryLabels(data: ChartData, series: Series[], paint: ChartPaint): string[] {
  const count = Math.max(data.categories.length, ...series.map((s) => s.values.length), 0);
  return Array.from({ length: count }, (_, i) => {
    const v = data.categories[i];
    return v === undefined ? String(i + 1) : paint.format(v, data.categoryFormat);
  });
}

/** Text cut to `width` with an ellipsis. */
function fit(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= width) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${text.slice(0, lo)}…` : '';
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

interface LegendItem {
  label: string;
  color: string;
}

const SWATCH = 10;

/** Draws the legend on its side of `box`; returns what is left for the plot. */
function drawLegend(ctx: CanvasRenderingContext2D, box: Rect, where: NonNullable<Chart['legend']>, items: LegendItem[], paint: ChartPaint): Rect {
  if (where === 'none' || items.length === 0) return box;
  ctx.font = SMALL;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const widthOf = (item: LegendItem) => SWATCH + 6 + Math.min(ctx.measureText(item.label).width, 160) + 14;
  if (where === 'right') {
    const width = Math.min(box.w * 0.4, Math.max(...items.map(widthOf)));
    const top = box.y + Math.max(0, (box.h - items.length * LINE) / 2);
    items.forEach((item, i) => legendItem(ctx, box.x + box.w - width, top + i * LINE, width, item, paint));
    return { ...box, w: box.w - width - 8 };
  }
  // Top or bottom: as many rows as it takes, each centred.
  const rows: LegendItem[][] = [[]];
  let used = 0;
  for (const item of items) {
    const w = widthOf(item);
    if (used + w > box.w && rows[rows.length - 1]!.length) {
      rows.push([]);
      used = 0;
    }
    rows[rows.length - 1]!.push(item);
    used += w;
  }
  const height = Math.min(rows.length, 3) * LINE;
  const y0 = where === 'top' ? box.y : box.y + box.h - height;
  rows.slice(0, 3).forEach((row, r) => {
    const total = row.reduce((n, item) => n + widthOf(item), 0);
    let x = box.x + Math.max(0, (box.w - total) / 2);
    for (const item of row) {
      legendItem(ctx, x, y0 + r * LINE, widthOf(item), item, paint);
      x += widthOf(item);
    }
  });
  return where === 'top' ? { ...box, y: box.y + height + 6, h: box.h - height - 6 } : { ...box, h: box.h - height - 6 };
}

function legendItem(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, item: LegendItem, paint: ChartPaint): void {
  ctx.fillStyle = item.color;
  ctx.fillRect(x, y + (LINE - SWATCH) / 2, SWATCH, SWATCH);
  ctx.fillStyle = paint.text;
  ctx.fillText(fit(ctx, item.label, width - SWATCH - 20), x + SWATCH + 6, y + LINE / 2);
}

// ---------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------

interface Scale {
  min: number;
  max: number;
  ticks: number[];
}

/** Round tick values covering [min, max]: steps of 1, 2 or 5 times a power of ten. */
export function niceScale(min: number, max: number, count = 5): Scale {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, ticks: [0, 1] };
  if (min === max) {
    const pad = Math.abs(min) || 1;
    return niceScale(min - pad, max + pad, count);
  }
  const step = niceStep((max - min) / Math.max(1, count - 1));
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return { min: lo, max: hi, ticks };
}

function niceStep(raw: number): number {
  const power = 10 ** Math.floor(Math.log10(raw));
  const f = raw / power;
  let nice = 10;
  if (f <= 1) nice = 1;
  else if (f <= 2) nice = 2;
  else if (f <= 5) nice = 5;
  return nice * power;
}

const stacked = (chart: Chart) => (chart.type === 'column' || chart.type === 'bar' || chart.type === 'area') && !!chart.stacking;

/** For stacked charts, each series' value on top of the ones before it (as shares for 100%). */
function stackSeries(chart: Chart, series: Series[], count: number): { lo: number[][]; hi: number[][] } {
  const lo = series.map(() => new Array<number>(count).fill(0));
  const hi = series.map(() => new Array<number>(count).fill(0));
  for (let i = 0; i < count; i++) {
    const total = series.reduce((n, s) => n + Math.abs(s.values[i] ?? 0), 0) || 1;
    let up = 0;
    let down = 0;
    series.forEach((s, k) => {
      const raw = s.values[i] ?? 0;
      const v = chart.stacking === 'percent' ? raw / total : raw;
      const base = v >= 0 ? up : down;
      lo[k]![i] = base;
      hi[k]![i] = base + v;
      if (v >= 0) up += v;
      else down += v;
    });
  }
  return { lo, hi };
}

// ---------------------------------------------------------------------------
// Column, bar, line and area
// ---------------------------------------------------------------------------

interface Frame {
  plot: Rect;
  /** Position of a value along the value axis. */
  at: (v: number) => number;
  /** Centre and width of a category's band. */
  band: (i: number) => { mid: number; size: number };
}

function drawCartesian(ctx: CanvasRenderingContext2D, box: Rect, chart: Chart, series: Series[], labels: string[], paint: ChartPaint): void {
  const count = labels.length;
  const stack = stacked(chart) ? stackSeries(chart, series, count) : null;
  const all = stack ? [...stack.lo.flat(), ...stack.hi.flat()] : series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const scale = niceScale(Math.min(0, ...all), Math.max(0, ...all));
  const percent = chart.stacking === 'percent';
  const tickLabel = (v: number) => (percent ? `${Math.round(v * 100)}%` : paint.format(v, series[0]?.format));
  const frame = drawAxes(ctx, box, chart, scale, labels, tickLabel, paint);
  if (chart.type === 'column' || chart.type === 'bar') drawBars(ctx, frame, chart, series, count, stack);
  else drawLines(ctx, frame, chart, series, count, stack);
}

/** Gridlines, tick labels, category labels and axis titles; the plot's frame. */
function drawAxes(ctx: CanvasRenderingContext2D, box: Rect, chart: Chart, scale: Scale, labels: string[], tickLabel: (v: number) => string, paint: ChartPaint): Frame {
  const horizontal = chart.type === 'bar';
  ctx.font = SMALL;
  const tickTexts = scale.ticks.map(tickLabel);
  const tickWidth = Math.max(...tickTexts.map((t) => ctx.measureText(t).width));
  const labelWidth = Math.min(box.w * 0.3, Math.max(0, ...labels.map((l) => ctx.measureText(l).width)));
  const yTitle = horizontal ? chart.xTitle : chart.yTitle;
  const xTitle = horizontal ? chart.yTitle : chart.xTitle;
  const left = box.x + (yTitle ? LINE + 4 : 0) + (horizontal ? labelWidth : tickWidth) + 8;
  const bottom = box.y + box.h - (xTitle ? LINE + 4 : 0) - LINE - 4;
  const plot: Rect = { x: left, y: box.y + 4, w: box.x + box.w - left - 4, h: bottom - box.y - 4 };
  const span = scale.max - scale.min || 1;
  const at = horizontal ? (v: number) => plot.x + ((v - scale.min) / span) * plot.w : (v: number) => plot.y + plot.h - ((v - scale.min) / span) * plot.h;
  const bandSize = (horizontal ? plot.h : plot.w) / Math.max(1, labels.length);
  const band = (i: number) => ({ mid: (horizontal ? plot.y : plot.x) + bandSize * (i + 0.5), size: bandSize });

  ctx.strokeStyle = paint.grid;
  ctx.fillStyle = paint.muted;
  ctx.lineWidth = 1;
  scale.ticks.forEach((t, i) => {
    const p = Math.round(at(t)) + 0.5;
    ctx.beginPath();
    if (horizontal) {
      ctx.moveTo(p, plot.y);
      ctx.lineTo(p, plot.y + plot.h);
    } else {
      ctx.moveTo(plot.x, p);
      ctx.lineTo(plot.x + plot.w, p);
    }
    ctx.stroke();
    ctx.textAlign = horizontal ? 'center' : 'right';
    ctx.textBaseline = horizontal ? 'top' : 'middle';
    if (horizontal) ctx.fillText(tickTexts[i]!, p, plot.y + plot.h + 4);
    else ctx.fillText(tickTexts[i]!, plot.x - 6, p);
  });
  drawCategoryLabels(ctx, labels, band, plot, horizontal, labelWidth);
  drawAxisTitles(ctx, box, plot, xTitle, yTitle, paint);
  return { plot, at, band };
}

function drawCategoryLabels(
  ctx: CanvasRenderingContext2D,
  labels: string[],
  band: (i: number) => { mid: number; size: number },
  plot: Rect,
  horizontal: boolean,
  labelWidth: number,
): void {
  ctx.textAlign = horizontal ? 'right' : 'center';
  ctx.textBaseline = horizontal ? 'middle' : 'top';
  const size = band(0).size;
  const widest = Math.max(1, ...labels.map((l) => ctx.measureText(l).width));
  // Every label when there is room, else every k-th.
  const every = horizontal ? Math.max(1, Math.ceil(LINE / size)) : Math.max(1, Math.ceil((widest + 8) / size));
  labels.forEach((label, i) => {
    if (i % every !== 0) return;
    const { mid } = band(i);
    if (horizontal) ctx.fillText(fit(ctx, label, labelWidth), plot.x - 6, mid);
    else ctx.fillText(fit(ctx, label, size * every - 4), mid, plot.y + plot.h + 4);
  });
}

function drawAxisTitles(ctx: CanvasRenderingContext2D, box: Rect, plot: Rect, xTitle: string | undefined, yTitle: string | undefined, paint: ChartPaint): void {
  ctx.font = FONT;
  ctx.fillStyle = paint.text;
  if (xTitle) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(fit(ctx, xTitle, plot.w), plot.x + plot.w / 2, box.y + box.h);
  }
  if (yTitle) {
    ctx.save();
    ctx.translate(box.x, plot.y + plot.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(fit(ctx, yTitle, plot.h), 0, 0);
    ctx.restore();
  }
}

function drawBars(ctx: CanvasRenderingContext2D, frame: Frame, chart: Chart, series: Series[], count: number, stack: { lo: number[][]; hi: number[][] } | null): void {
  const horizontal = chart.type === 'bar';
  const zero = frame.at(0);
  for (let i = 0; i < count; i++) {
    const { mid, size } = frame.band(i);
    const groupWidth = size * 0.75;
    const barWidth = stack ? groupWidth : groupWidth / Math.max(1, series.length);
    series.forEach((s, k) => {
      const v = s.values[i];
      if (v === null || v === undefined) return;
      const from = stack ? frame.at(stack.lo[k]![i]!) : zero;
      const to = stack ? frame.at(stack.hi[k]![i]!) : frame.at(v);
      const offset = stack ? -groupWidth / 2 : -groupWidth / 2 + k * barWidth;
      ctx.fillStyle = s.color;
      if (horizontal) ctx.fillRect(Math.min(from, to), mid + offset, Math.abs(to - from), barWidth - 1);
      else ctx.fillRect(mid + offset, Math.min(from, to), barWidth - 1, Math.abs(to - from));
    });
  }
}

function drawLines(ctx: CanvasRenderingContext2D, frame: Frame, chart: Chart, series: Series[], count: number, stack: { lo: number[][]; hi: number[][] } | null): void {
  const area = chart.type === 'area';
  // Areas are drawn back to front so the first series stays on top.
  const order = area ? [...series.keys()].reverse() : [...series.keys()];
  for (const k of order) {
    const s = series[k]!;
    const point = (i: number): [number, number] | null => {
      const v = s.values[i];
      if (v === null || v === undefined) return null;
      return [frame.band(i).mid, frame.at(stack ? stack.hi[k]![i]! : v)];
    };
    if (area) fillArea(ctx, frame, s, count, point, stack ? (i) => frame.at(stack.lo[k]![i]!) : () => frame.at(0));
    strokeLine(ctx, s.color, count, point);
    if (!area && count <= 40) markers(ctx, s.color, count, point);
  }
}

function strokeLine(ctx: CanvasRenderingContext2D, color: string, count: number, point: (i: number) => [number, number] | null): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let pen = false;
  for (let i = 0; i < count; i++) {
    const p = point(i);
    if (!p) {
      pen = false;
      continue;
    }
    if (pen) ctx.lineTo(p[0], p[1]);
    else ctx.moveTo(p[0], p[1]);
    pen = true;
  }
  ctx.stroke();
}

function markers(ctx: CanvasRenderingContext2D, color: string, count: number, point: (i: number) => [number, number] | null): void {
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    const p = point(i);
    if (!p) continue;
    ctx.beginPath();
    ctx.arc(p[0], p[1], 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function fillArea(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  s: Series,
  count: number,
  point: (i: number) => [number, number] | null,
  base: (i: number) => number,
): void {
  const points = Array.from({ length: count }, (_, i) => ({ i, p: point(i) })).filter((e): e is { i: number; p: [number, number] } => e.p !== null);
  if (points.length < 2) return;
  ctx.beginPath();
  points.forEach(({ p }, n) => (n ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  for (const { i } of [...points].reverse()) ctx.lineTo(frame.band(i).mid, base(i));
  ctx.closePath();
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = s.color;
  ctx.fill();
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// Pie and scatter
// ---------------------------------------------------------------------------

function drawPie(ctx: CanvasRenderingContext2D, box: Rect, s: Series, doughnut: boolean, paint: ChartPaint): void {
  const values = s.values.map((v) => (v !== null && v > 0 ? v : 0));
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    drawEmpty(ctx, box, paint);
    return;
  }
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const r = Math.max(4, Math.min(box.w, box.h) / 2 - 4);
  let angle = -Math.PI / 2;
  ctx.font = SMALL;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  values.forEach((v, i) => {
    const sweep = (v / total) * Math.PI * 2;
    ctx.fillStyle = CHART_PALETTE[i % CHART_PALETTE.length]!;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle + sweep);
    ctx.closePath();
    ctx.fill();
    if (v / total >= 0.06) {
      const mid = angle + sweep / 2;
      const at = doughnut ? r * 0.78 : r * 0.62;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(`${Math.round((v / total) * 100)}%`, cx + Math.cos(mid) * at, cy + Math.sin(mid) * at);
    }
    angle += sweep;
  });
  if (doughnut) {
    ctx.fillStyle = paint.background;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawScatter(ctx: CanvasRenderingContext2D, box: Rect, chart: Chart, series: Series[], paint: ChartPaint): void {
  const xs = series.flatMap((s) => (s.x ?? s.values.map((_, i) => i + 1)).filter((v): v is number => v !== null && v !== undefined));
  const ys = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const xScale = niceScale(Math.min(...xs), Math.max(...xs));
  const yScale = niceScale(Math.min(...ys), Math.max(...ys));
  const xLabels = xScale.ticks.map((t) => paint.format(t, undefined));
  // The x axis is numeric too: its ticks are the "categories", placed by value.
  const frame = drawAxes(ctx, box, { ...chart, type: 'line' }, yScale, [], (v) => paint.format(v, series[0]?.format), paint);
  const xAt = (v: number) => frame.plot.x + ((v - xScale.min) / (xScale.max - xScale.min || 1)) * frame.plot.w;
  ctx.font = SMALL;
  ctx.fillStyle = paint.muted;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  xScale.ticks.forEach((t, i) => ctx.fillText(xLabels[i]!, xAt(t), frame.plot.y + frame.plot.h + 4));
  for (const s of series) {
    ctx.fillStyle = s.color;
    s.values.forEach((y, i) => {
      const x = s.x ? s.x[i] : i + 1;
      if (y === null || x === null || x === undefined) return;
      ctx.beginPath();
      ctx.arc(xAt(x), frame.at(y), 3.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }
}
