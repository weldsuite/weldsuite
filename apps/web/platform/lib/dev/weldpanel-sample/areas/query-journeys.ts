/** Sample answers for funnels, funnel correlation, retention, flows, stickiness and lifecycle. */

import type {
  PanelCorrelationRow,
  PanelFlowPath,
  PanelFlowsResult,
  PanelFlowsSpec,
  PanelFunnelCorrelationResult,
  PanelFunnelCorrelationSpec,
  PanelFunnelResult,
  PanelFunnelSpec,
  PanelFunnelStepResult,
  PanelFunnelTimeToConvert,
  PanelInterval,
  PanelLifecycleBucket,
  PanelLifecycleResult,
  PanelLifecycleSpec,
  PanelRetentionCohort,
  PanelRetentionResult,
  PanelRetentionSpec,
  PanelStickinessBucket,
  PanelStickinessResult,
  PanelStickinessSpec,
  PanelTimeHistogramBucket,
  PanelTimeToConvertStats,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { bucketsFor, dailyValue, pick, resolveRange, rng, seriesValues, ymd } from '../dataset';
import {
  breakdownWeights,
  breakdownsOf,
  clamp,
  eventLabel,
  eventVolume,
  filterFactor,
  isApp,
  pageWeights,
  resolved,
  round,
  splitValues,
  sum,
  uniquePerDay,
  uniqueOver,
  type SplitValue,
  type Weighted,
} from './query-common';

function aggregateFactor(aggregateBy: unknown): number {
  return aggregateBy && aggregateBy !== 'person' ? 0.12 : 1;
}

/** Largest-remainder rounding of `total * weights` so the parts add up exactly. */
function apportion(total: number, weights: readonly number[]): number[] {
  const weightSum = sum(weights) || 1;
  const exact = weights.map((w) => (total * w) / weightSum);
  const floors = exact.map(Math.floor);
  let left = total - sum(floors);
  const order = exact.map((e, i) => ({ i, frac: e - Math.floor(e) })).sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i]! += 1;
    left -= 1;
  }
  return floors;
}

// ---------------------------------------------------------------------------
// Funnels
// ---------------------------------------------------------------------------

function stepRates(spec: PanelFunnelSpec, key: string): number[] {
  const random = rng(`${key}|rates`);
  const windowFactor = spec.window ? clamp(0.82 + Math.min(1, (spec.window.unit === 'day' ? spec.window.value * 24 : spec.window.unit === 'hour' ? spec.window.value : spec.window.value / 60) / 168) * 0.18, 0.7, 1) : 1;
  const orderFactor = spec.order === 'strict' ? 0.85 : 1;
  const exclusionFactor = (spec.exclusions?.length ?? 0) > 0 ? 0.97 : 1;
  const rates: number[] = [1];
  for (let i = 1; i < spec.steps.length; i++) {
    const prev = eventVolume(spec.steps[i - 1]!.event, spec.projectId);
    const cur = eventVolume(spec.steps[i]!.event, spec.projectId);
    const ratio = cur / prev;
    let rate = ratio < 1 ? clamp(ratio ** 0.55 * (0.9 + random() * 0.2), 0.06, 0.92) : 0.5 + random() * 0.3;
    if (spec.steps[i]!.optional) rate = 0.8;
    rates.push(clamp(rate * windowFactor * orderFactor * exclusionFactor * filterFactor(spec.steps[i]!.filters) ** 0.25, 0.04, 0.97));
  }
  return rates;
}

function buildSteps(first: number, rates: readonly number[], spec: PanelFunnelSpec, key: string): PanelFunnelStepResult[] {
  const random = rng(`${key}|time`);
  const counts: number[] = [Math.max(1, first)];
  for (let i = 1; i < rates.length; i++) counts.push(Math.min(counts[i - 1]!, Math.max(0, Math.round(counts[i - 1]! * rates[i]!))));
  return spec.steps.map((step, i) => {
    const prev = i === 0 ? counts[0]! : counts[i - 1]!;
    const seconds = Math.round(40 * (i + 1) ** 2.1 * (0.7 + random() * 0.9) * (step.event.includes('checkout') || step.event.includes('upgrade') ? 40 : 3));
    return {
      index: i,
      event: step.event,
      label: step.label ?? eventLabel(step.event),
      count: counts[i]!,
      conversionFromPrevious: i === 0 ? 1 : prev > 0 ? counts[i]! / prev : 0,
      conversionFromFirst: counts[i]! / counts[0]!,
      droppedOff: i === 0 ? 0 : prev - counts[i]!,
      avgSecondsFromPrevious: i === 0 || counts[i] === 0 ? null : seconds,
      ...(step.optional ? { optional: true } : {}),
    };
  });
}

const HISTOGRAM_EDGES = [0, 30, 60, 180, 600, 1800, 7200, 28800, 86400];

function timeStats(count: number, targetSeconds: number, scale: number): PanelTimeToConvertStats {
  const edges = HISTOGRAM_EDGES.map((e) => Math.round(e * scale));
  const mids = edges.map((e, i) => (i === 0 ? Math.max(1, edges[1]! / 2) : Math.sqrt(Math.max(1, e) * (edges[i + 1] ?? e * 3))));
  const weights = mids.map((m) => Math.exp(-((Math.log(m) - Math.log(Math.max(1, targetSeconds))) ** 2) / (2 * 1.15 ** 2)) + 0.002);
  const counts = apportion(count, weights);
  const histogram: PanelTimeHistogramBucket[] = edges.map((from, i) => ({ fromSeconds: from, toSeconds: edges[i + 1] ?? null, count: counts[i]! }));
  const cumulative = (share: number): number => {
    let acc = 0;
    for (const b of histogram) {
      acc += b.count;
      if (acc >= count * share) return b.toSeconds === null ? Math.round(b.fromSeconds * 1.5) : Math.round((b.fromSeconds + b.toSeconds) / 2);
    }
    return Math.round(targetSeconds);
  };
  return { count, medianSeconds: count > 0 ? cumulative(0.5) : null, p90Seconds: count > 0 ? cumulative(0.9) : null, avgSeconds: count > 0 ? Math.round(targetSeconds) : null, histogram };
}

export function funnelResult(spec: PanelFunnelSpec): PanelFunnelResult {
  const projectId = spec.projectId;
  const range = resolveRange(spec.dateRange);
  const key = `${projectId}|funnel|${spec.steps.map((s) => s.event).join('>')}`;
  const first = Math.round(uniqueOver(uniquePerDay(spec.steps[0]!.event, projectId) * filterFactor(spec.filters) * filterFactor(spec.steps[0]!.filters) * aggregateFactor(spec.aggregateBy), range.days.length) * 0.9);
  const rates = stepRates(spec, key);
  const steps = buildSteps(first, rates, spec, key);
  const last = steps[steps.length - 1]!;
  const overallConversion = last.count / steps[0]!.count;

  const splits = splitValues(breakdownsOf(spec), projectId);
  const breakdowns = splits.length
    ? splits.map((split: SplitValue) => {
        const multiplier = 0.7 + rng(`${key}|bd|${split.value}`)() * 0.65;
        const adjusted = rates.map((r, i) => (i === 0 ? 1 : clamp(r * multiplier, 0.03, 0.98)));
        const bdSteps = buildSteps(Math.max(2, Math.round(first * split.share)), adjusted, spec, `${key}|${split.value}`);
        return { value: split.value, parts: split.parts, steps: bdSteps, overallConversion: bdSteps[bdSteps.length - 1]!.count / bdSteps[0]!.count };
      })
    : null;

  const windowSeconds = spec.window ? spec.window.value * (spec.window.unit === 'day' ? 86400 : spec.window.unit === 'hour' ? 3600 : 60) : 7 * 86400;
  const timeToConvert: PanelFunnelTimeToConvert = {
    overall: timeStats(last.count, Math.min(windowSeconds / 6, steps.reduce((s, st) => s + (st.avgSecondsFromPrevious ?? 0), 0)), 1),
    steps: steps.slice(1).map((st) => ({ index: st.index, ...timeStats(st.count, st.avgSecondsFromPrevious ?? 60, Math.max(0.2, (st.avgSecondsFromPrevious ?? 60) / 400)) })),
  };

  const interval: PanelInterval = spec.interval ?? 'day';
  const buckets = bucketsFor(range, interval);
  const weights = seriesValues(`${key}|entered`, range, 100, interval);
  const entered = apportion(steps[0]!.count, weights.map((w) => w + 1));
  const trend = buckets.map((bucket, i) => {
    const random = rng(`${key}|trend|${bucket}`);
    const e = entered[i] ?? 0;
    const converted = Math.min(e, Math.round(e * overallConversion * (0.82 + random() * 0.36)));
    return { bucket, entered: e, converted, conversion: e > 0 ? converted / e : 0 };
  });

  return { range: resolved(range, false, spec.timezone), steps, overallConversion, breakdowns, timeToConvert, trend, interval };
}

// ---------------------------------------------------------------------------
// Funnel correlation
// ---------------------------------------------------------------------------

interface Trait {
  type: 'event' | 'property';
  property: string | null;
  value: string;
  /** Share of people who dropped that have it. */
  prevalence: number;
  /** Odds of converting with it, relative to without. */
  effect: number;
}

const EVENT_TRAITS: Array<{ value: string; prevalence: number; effect: number }> = [
  { value: 'watched_demo_video', prevalence: 0.14, effect: 2.6 },
  { value: 'pricing_viewed', prevalence: 0.46, effect: 1.9 },
  { value: 'invited_teammate', prevalence: 0.09, effect: 3.1 },
  { value: 'docs_opened', prevalence: 0.18, effect: 1.7 },
  { value: 'compared_plans', prevalence: 0.22, effect: 1.55 },
  { value: 'read_case_study', prevalence: 0.12, effect: 1.8 },
  { value: 'used_search', prevalence: 0.17, effect: 1.35 },
  { value: 'clicked_chat_widget', prevalence: 0.11, effect: 1.45 },
  { value: '$rageclick', prevalence: 0.06, effect: 0.45 },
  { value: '$exception', prevalence: 0.05, effect: 0.4 },
  { value: 'visited_careers', prevalence: 0.07, effect: 0.5 },
  { value: 'cookie_banner_dismissed', prevalence: 0.38, effect: 0.82 },
  { value: 'unsubscribed_newsletter', prevalence: 0.03, effect: 0.35 },
  { value: 'form_error_shown', prevalence: 0.08, effect: 0.55 },
];

function propertyTraits(projectId: string): Trait[] {
  const out: Trait[] = [];
  const add = (property: string, effects: Record<string, number>): void => {
    const values = breakdownWeights({ source: 'column', field: property as 'country', limit: 5 }, projectId).slice(0, 4);
    const total = sum(values.map((v) => v.weight));
    for (const v of values) out.push({ type: 'property', property, value: v.value, prevalence: v.weight / total, effect: effects[v.value] ?? 1.02 });
  };
  add('country', { NL: 1.35, DE: 1.2, US: 0.8 });
  add('device_type', { desktop: 1.25, mobile: 0.58, tablet: 0.8 });
  add('browser', { Safari: 0.85, Chrome: 1.1 });
  add('os', { macOS: 1.18, Android: 0.6, iOS: 0.7 });
  add('utm_source', { newsletter: 1.7, linkedin: 1.3, google: 1.1 });
  add('referrer_host', { 'google.com': 1.15, 'linkedin.com': 1.3 });
  return out;
}

function correlationRow(trait: Trait, converted: number, dropped: number): PanelCorrelationRow {
  const random = rng(`corr|${trait.property ?? 'event'}|${trait.value}`);
  const prevalence = clamp(trait.prevalence * (0.92 + random() * 0.16), 0.01, 0.9);
  const failureCount = Math.max(1, Math.round(dropped * prevalence));
  const successCount = Math.max(1, Math.min(converted - 1, Math.round(failureCount * trait.effect * (converted / Math.max(1, dropped)))));
  const withTotal = successCount + failureCount;
  const withoutSuccess = converted - successCount;
  const withoutTotal = withoutSuccess + (dropped - failureCount);
  const oddsRatio = (successCount + 1) / (failureCount + 1) / ((withoutSuccess + 1) / (dropped - failureCount + 1));
  return {
    type: trait.type,
    property: trait.property,
    value: trait.value,
    successCount,
    failureCount,
    successRateWith: withTotal > 0 ? successCount / withTotal : 0,
    successRateWithout: withoutTotal > 0 ? withoutSuccess / withoutTotal : 0,
    oddsRatio: round(oddsRatio, 3),
    correlation: oddsRatio >= 1 ? 'positive' : 'negative',
  };
}

function rankRows(rows: PanelCorrelationRow[], limit: number): PanelCorrelationRow[] {
  const positive = rows.filter((r) => r.correlation === 'positive').sort((a, b) => b.oddsRatio - a.oddsRatio).slice(0, limit);
  const negative = rows.filter((r) => r.correlation === 'negative').sort((a, b) => a.oddsRatio - b.oddsRatio).slice(0, limit);
  return [...positive, ...negative];
}

export function funnelCorrelationResult(spec: PanelFunnelCorrelationSpec): PanelFunnelCorrelationResult {
  const funnel = funnelResult({ ...spec, kind: 'funnel' });
  const converted = funnel.steps[funnel.steps.length - 1]!.count;
  const dropped = Math.max(1, funnel.steps[0]!.count - converted);
  const limit = spec.limit ?? 10;
  const used = new Set(spec.steps.map((s) => s.event));
  const eventRows = EVENT_TRAITS.filter((t) => !used.has(t.value)).map((t) => correlationRow({ type: 'event', property: null, ...t }, converted, dropped));
  const propertyRows = propertyTraits(spec.projectId).map((t) => correlationRow(t, converted, dropped));
  return { range: funnel.range, converted, dropped, events: rankRows(eventRows, limit), properties: rankRows(propertyRows, limit) };
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

const CURVES: Record<'day' | 'week' | 'month', number[]> = {
  day: [1, 0.34, 0.26, 0.22, 0.2, 0.18, 0.17, 0.155, 0.145, 0.14, 0.13, 0.125, 0.12, 0.115, 0.11, 0.105, 0.1, 0.098, 0.095, 0.092, 0.09, 0.088, 0.086, 0.084, 0.082, 0.08, 0.078, 0.076, 0.075, 0.074, 0.073],
  week: [1, 0.46, 0.38, 0.34, 0.31, 0.29, 0.275, 0.26, 0.25, 0.24, 0.232, 0.225, 0.22, 0.215, 0.21, 0.205, 0.2, 0.196, 0.192, 0.188, 0.185, 0.182, 0.18, 0.178, 0.176, 0.174, 0.172, 0.17, 0.168, 0.166, 0.164],
  month: [1, 0.58, 0.49, 0.44, 0.41, 0.385, 0.365, 0.35, 0.337, 0.325, 0.315, 0.306, 0.298, 0.29, 0.283, 0.277, 0.271, 0.266, 0.261, 0.256, 0.252, 0.248, 0.244, 0.24, 0.237, 0.234, 0.231, 0.228, 0.225, 0.222, 0.22],
};

function retentionCohorts(spec: PanelRetentionSpec, key: string, sizeScale: number, retentionScale: number): { cohorts: PanelRetentionCohort[]; average: number[] } {
  const projectId = spec.projectId;
  const range = resolveRange(spec.dateRange);
  const interval = spec.interval ?? 'week';
  const periods = spec.periods ?? 8;
  const buckets = bucketsFor(range, interval);
  const curve = CURVES[interval];
  const perDay = uniquePerDay(spec.firstEvent, projectId) * (spec.mode === 'recurring' ? 0.9 : 0.28) * filterFactor(spec.filters) * aggregateFactor(spec.aggregateBy) * sizeScale;
  const boost = (spec.unbounded ? 1.18 : 1) * retentionScale;
  const cohorts: PanelRetentionCohort[] = buckets.map((bucket, i) => {
    const start = new Date(bucket);
    const end = new Date(buckets[i + 1] ?? new Date(`${range.to}T23:59:59`).toISOString());
    const bucketDays = range.days.filter((d) => {
      const t = new Date(`${d}T00:00:00`);
      return t >= start && (buckets[i + 1] ? t < end : true);
    });
    const size = Math.max(3, bucketDays.reduce((s, d) => s + dailyValue(`${key}|size`, d, perDay), 0));
    const elapsed = buckets.length - 1 - i;
    const length = Math.min(periods, elapsed) + 1;
    const random = rng(`${key}|${bucket}`);
    const counts: number[] = [size];
    for (let n = 1; n < length; n++) {
      const share = clamp((curve[n] ?? curve[curve.length - 1]!) * boost * (0.9 + random() * 0.2), 0.01, 0.95);
      counts.push(Math.min(counts[n - 1]!, Math.round(size * share)));
    }
    return { cohort: ymd(start), size, counts };
  });
  const average: number[] = [];
  for (let n = 0; n <= periods; n++) {
    const have = cohorts.filter((c) => c.counts[n] !== undefined);
    const denominator = sum(have.map((c) => c.size));
    average.push(denominator > 0 ? round(sum(have.map((c) => c.counts[n]!)) / denominator, 4) : round((curve[n] ?? 0.1) * boost * 0.97, 4));
  }
  return { cohorts, average };
}

export function retentionResult(spec: PanelRetentionSpec): PanelRetentionResult {
  const projectId = spec.projectId;
  const range = resolveRange(spec.dateRange);
  const key = `${projectId}|retention|${spec.firstEvent}|${spec.returnEvent ?? 'any'}`;
  const main = retentionCohorts(spec, key, 1, spec.returnEvent ? 1 : 1.12);
  const splits = splitValues(breakdownsOf(spec), projectId).slice(0, 5);
  const breakdowns = splits.length
    ? splits.map((split) => {
        const r = retentionCohorts(spec, `${key}|${split.value}`, split.share, 0.75 + rng(`${key}|r|${split.value}`)() * 0.5);
        return { value: split.value, cohorts: r.cohorts, averageRetention: r.average };
      })
    : null;
  return {
    range: resolved(range, false, spec.timezone),
    interval: spec.interval ?? 'week',
    periods: spec.periods ?? 8,
    cohorts: main.cohorts,
    averageRetention: main.average,
    mode: spec.mode ?? null,
    unbounded: spec.unbounded ?? false,
    breakdowns,
  };
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

const CUSTOM_STEPS = ['signup_started', 'signup_completed', 'trial_started', 'demo_requested', 'newsletter_subscribed', 'docs_opened', 'watched_demo_video'];
const APP_CUSTOM_STEPS = ['ticket_created', 'email_sent', 'invoice_sent', 'member_invited', 'module_installed', 'workspace_created'];

function flowPool(spec: PanelFlowsSpec): Weighted[] {
  const projectId = spec.projectId;
  const pages = pageWeights(projectId);
  const events = (isApp(projectId) ? APP_CUSTOM_STEPS : CUSTOM_STEPS).map((name, i) => ({ value: name, weight: 9 - i }));
  const scope = spec.scope ?? 'all';
  if (scope === 'pageviews') return pages;
  if (scope === 'custom') return events;
  return [...pages.map((p) => ({ value: p.value, weight: p.weight * 0.8 })), ...events.map((e) => ({ value: e.value, weight: e.weight * 1.4 }))];
}

function transitionWeight(from: string | null, candidate: string, base: number): number {
  if (from === candidate) return base * 0.05;
  if (from === '/pricing' && (candidate === '/signup' || candidate === 'signup_started')) return base * 3.2;
  if (from === '/pricing' && candidate === '/contact') return base * 2;
  if (from === '/' && candidate === '/pricing') return base * 2.6;
  if (from === '/signup' && (candidate === 'signup_completed' || candidate === 'signup_started')) return base * 4;
  if (from === 'signup_started' && candidate === 'signup_completed') return base * 5;
  if (from === 'signup_completed' && candidate === 'trial_started') return base * 4;
  if (from === '/login' && candidate === '/home') return base * 4;
  return base;
}

export function flowsResult(spec: PanelFlowsSpec): PanelFlowsResult {
  const projectId = spec.projectId;
  const range = resolveRange(spec.dateRange);
  const depth = spec.depth ?? 3;
  const limit = spec.limit ?? 20;
  const direction = spec.direction ?? 'after';
  const anchor = spec.anchor.event;
  const anchorCount = Math.max(20, Math.round(range.days.reduce((s, d) => s + dailyValue(`${projectId}|flow|${anchor}`, d, eventVolume(anchor, projectId) * 0.7), 0) * filterFactor(spec.filters) * filterFactor(spec.anchor.filters)));
  const pool = flowPool(spec);
  const random = rng(`${projectId}|flows|${anchor}|${direction}|${spec.scope ?? 'all'}`);
  const leave = [0.34, 0.3, 0.28, 0.27, 0.26];
  const draws = 900;
  const tally = new Map<string, { steps: (string | null)[]; n: number }>();
  for (let d = 0; d < draws; d++) {
    const steps: (string | null)[] = [];
    let current: string | null = anchor;
    for (let s = 0; s < depth; s++) {
      if (current === null || random() < leave[s]!) {
        steps.push(null);
        current = null;
        continue;
      }
      const from: string | null = current;
      const items: string[] = pool.map((p) => p.value);
      const weights: number[] = pool.map((p) => transitionWeight(from, p.value, p.weight));
      current = pick(random, items, weights);
      steps.push(current);
    }
    const id = steps.join('\u0000');
    const entry = tally.get(id) ?? { steps, n: 0 };
    entry.n += 1;
    tally.set(id, entry);
  }
  const entries = [...tally.values()].sort((a, b) => b.n - a.n);
  const counts = apportion(anchorCount, entries.map((e) => e.n));
  const paths: PanelFlowPath[] = entries
    .map((e, i) => ({ steps: e.steps, count: counts[i]! }))
    .filter((p) => p.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
  return { range: resolved(range, false, spec.timezone), anchor, direction, depth, anchorCount, paths };
}

// ---------------------------------------------------------------------------
// Stickiness
// ---------------------------------------------------------------------------

export function stickinessResult(spec: PanelStickinessSpec): PanelStickinessResult {
  const projectId = spec.projectId;
  const range = resolveRange(spec.dateRange);
  const interval = spec.interval ?? 'day';
  const measure = spec.measure ?? 'intervals';
  const total = Math.max(10, uniqueOver(uniquePerDay(spec.event, projectId) * filterFactor(spec.filters) * aggregateFactor(spec.aggregateBy), range.days.length));
  const intervalsInRange = interval === 'week' ? bucketsFor(range, 'week').length : range.days.length;

  let defs: { label: string; from: number; to: number | null; weight: number }[];
  if (measure === 'count') {
    const edges: [number, number | null][] = [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 10], [11, 25], [26, 50], [51, null]];
    const weights = [38, 17, 10, 7, 5, 12, 7, 3, 1];
    defs = edges.map(([from, to], i) => ({ label: to === null ? `${from}+` : from === to ? String(from) : `${from}–${to}`, from, to, weight: weights[i]! }));
  } else if (intervalsInRange <= 31) {
    defs = Array.from({ length: intervalsInRange }, (_, i) => ({ label: String(i + 1), from: i + 1, to: i + 1, weight: (i + 1) ** -1.2 * (i + 1 === intervalsInRange ? 1.6 : 1) }));
  } else {
    const size = Math.ceil(intervalsInRange / 12);
    defs = [];
    for (let from = 1; from <= intervalsInRange; from += size) {
      const to = Math.min(intervalsInRange, from + size - 1);
      let w = 0;
      for (let k = from; k <= to; k++) w += k ** -1.2;
      defs.push({ label: from === to ? String(from) : `${from}–${to}`, from, to, weight: w });
    }
  }
  const counts = apportion(total, defs.map((d) => d.weight));
  const buckets: PanelStickinessBucket[] = defs.map((d, i) => ({ label: d.label, from: d.from, to: d.to, count: counts[i]!, share: counts[i]! / total }));
  return { range: resolved(range, false, spec.timezone), interval, measure, total, intervalsInRange, buckets };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function lifecycleResult(spec: PanelLifecycleSpec): PanelLifecycleResult {
  const projectId = spec.projectId;
  const range = resolveRange(spec.dateRange);
  const interval = spec.interval ?? 'day';
  const buckets = bucketsFor(range, interval);
  const perDay = uniquePerDay(spec.event, projectId) * filterFactor(spec.filters) * aggregateFactor(spec.aggregateBy);
  const active = seriesValues(`${projectId}|lifecycle|${spec.event}`, range, perDay, interval).map((v) => Math.max(5, Math.round(v * (interval === 'day' ? 1 : 0.72))));
  const rows: PanelLifecycleBucket[] = buckets.map((bucket, i) => {
    const random = rng(`${projectId}|lc|${spec.event}|${bucket}`);
    const a = active[i]!;
    const fresh = Math.round(a * (0.19 + random() * 0.07));
    const resurrecting = Math.round(a * (0.05 + random() * 0.04));
    const returning = Math.max(0, a - fresh - resurrecting);
    const previousActive = i === 0 ? Math.round(a * 0.96) : active[i - 1]!;
    return { bucket, new: fresh, returning, resurrecting, dormant: Math.max(0, previousActive - returning) };
  });
  return {
    range: resolved(range, false, spec.timezone),
    interval,
    buckets: rows,
    totals: {
      new: sum(rows.map((r) => r.new)),
      returning: sum(rows.map((r) => r.returning)),
      resurrecting: sum(rows.map((r) => r.resurrecting)),
      dormant: sum(rows.map((r) => r.dormant)),
    },
  };
}
