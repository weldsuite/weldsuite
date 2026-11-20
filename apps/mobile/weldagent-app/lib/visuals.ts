/**
 * Chart geometry for the chat visuals (ADR AGENT-016), drawn with
 * react-native-svg: scales, ticks, line and area paths, pie arcs. Pure
 * functions, so the drawing is tested without a renderer.
 */

import type { ChartVisual } from '@weldsuite/app-api-client/schemas/chat-visuals';

/** Series colours, in order: the WeldAgent violet, then distinct hues that read on light and dark. */
export const VISUAL_PALETTE = ['#8d65ef', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#6366f1', '#14b8a6', '#ec4899'];

export function seriesColor(index: number): string {
  return VISUAL_PALETTE[index % VISUAL_PALETTE.length];
}

/** A round step (1, 2, 5 × 10ⁿ) that splits `span` into about `count` parts. */
export function niceStep(span: number, count: number): number {
  if (!(span > 0) || count < 1) return 1;
  const raw = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const residual = raw / magnitude;
  let nice = 10;
  if (residual < 1.5) nice = 1;
  else if (residual < 3) nice = 2;
  else if (residual < 7) nice = 5;
  return nice * magnitude;
}

/** Axis ticks from at or below `min` to at or above `max`, always including 0 when in range. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) {
    if (min === 0) return [0, 1];
    return min > 0 ? [0, min] : [min, 0];
  }
  const step = niceStep(max - min, count);
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

/** The value range a chart needs: 0 included, stacked series added up per label. */
export function valueRange(visual: ChartVisual): [number, number] {
  let min = 0;
  let max = 0;
  visual.labels.forEach((_, i) => {
    if (visual.stacked) {
      let positive = 0;
      let negative = 0;
      for (const s of visual.series) {
        const v = s.values[i] ?? 0;
        if (v >= 0) positive += v;
        else negative += v;
      }
      max = Math.max(max, positive);
      min = Math.min(min, negative);
    } else {
      for (const s of visual.series) {
        const v = s.values[i];
        if (v === null || v === undefined) continue;
        max = Math.max(max, v);
        min = Math.min(min, v);
      }
    }
  });
  return [min, max];
}

/** Map `domain` onto `range` linearly. */
export function linearScale(domain: [number, number], range: [number, number]): (value: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (value) => r0 + ((value - d0) / span) * (r1 - r0);
}

export interface Point {
  x: number;
  y: number;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** An SVG path through the points; a null point breaks the line. */
export function linePath(points: (Point | null)[]): string {
  let d = '';
  let drawing = false;
  for (const p of points) {
    if (!p) {
      drawing = false;
      continue;
    }
    d += `${drawing ? 'L' : 'M'}${round(p.x)} ${round(p.y)}`;
    drawing = true;
  }
  return d;
}

/** A closed SVG path filling from the line down (or up) to `baseline`, one area per unbroken run. */
export function areaPath(points: (Point | null)[], baseline: number | number[]): string {
  const base = (i: number) => (Array.isArray(baseline) ? baseline[i] : baseline);
  let d = '';
  let run: { p: Point; i: number }[] = [];
  const close = () => {
    if (run.length === 0) return;
    d += `M${round(run[0].p.x)} ${round(base(run[0].i))}`;
    for (const { p } of run) d += `L${round(p.x)} ${round(p.y)}`;
    for (let k = run.length - 1; k >= 0; k -= 1) d += `L${round(run[k].p.x)} ${round(base(run[k].i))}`;
    d += 'Z';
    run = [];
  };
  points.forEach((p, i) => {
    if (p) run.push({ p, i });
    else close();
  });
  close();
  return d;
}

export interface Slice {
  label: string;
  value: number;
  /** Index into the labels, or -1 for the "Other" slice. */
  index: number;
  startAngle: number;
  endAngle: number;
}

/** Pie slices from the first series: positive values, the largest 7 kept and the rest as "Other". */
export function pieSlices(visual: ChartVisual, otherLabel: string, max = 8): Slice[] {
  const values = visual.series[0]?.values ?? [];
  let slices = visual.labels
    .map((label, index) => ({ label, value: values[index] ?? 0, index }))
    .filter((s) => s.value > 0);
  if (slices.length > max) {
    const sorted = [...slices].sort((a, b) => b.value - a.value);
    const rest = sorted.slice(max - 1).reduce((sum, s) => sum + s.value, 0);
    slices = [...sorted.slice(0, max - 1).sort((a, b) => a.index - b.index), { label: otherLabel, value: rest, index: -1 }];
  }
  const total = slices.reduce((sum, s) => sum + s.value, 0) || 1;
  let angle = 0;
  return slices.map((s) => {
    const startAngle = angle;
    angle += (s.value / total) * Math.PI * 2;
    return { ...s, startAngle, endAngle: angle };
  });
}

function polar(cx: number, cy: number, r: number, angle: number): Point {
  // 0 is at twelve o'clock, clockwise.
  return { x: cx + r * Math.sin(angle), y: cy - r * Math.cos(angle) };
}

/** An SVG path for a pie slice, or a donut segment when `inner` > 0. */
export function arcPath(cx: number, cy: number, outer: number, inner: number, start: number, end: number): string {
  // A full circle cannot be one arc: draw it as two halves.
  if (end - start >= Math.PI * 2 - 1e-6) {
    const mid = start + Math.PI;
    return arcPath(cx, cy, outer, inner, start, mid) + arcPath(cx, cy, outer, inner, mid, end);
  }
  const large = end - start > Math.PI ? 1 : 0;
  const o0 = polar(cx, cy, outer, start);
  const o1 = polar(cx, cy, outer, end);
  if (inner <= 0) {
    return `M${round(cx)} ${round(cy)}L${round(o0.x)} ${round(o0.y)}A${outer} ${outer} 0 ${large} 1 ${round(o1.x)} ${round(o1.y)}Z`;
  }
  const i1 = polar(cx, cy, inner, end);
  const i0 = polar(cx, cy, inner, start);
  return (
    `M${round(o0.x)} ${round(o0.y)}A${outer} ${outer} 0 ${large} 1 ${round(o1.x)} ${round(o1.y)}` +
    `L${round(i1.x)} ${round(i1.y)}A${inner} ${inner} 0 ${large} 0 ${round(i0.x)} ${round(i0.y)}Z`
  );
}
