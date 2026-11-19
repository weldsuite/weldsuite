/** Sample answers for impact, signal, root-cause explanations and metric tree values. */

import type {
  PanelImpactResult,
  PanelImpactSpec,
  PanelSignalCandidate,
  PanelSignalResult,
  PanelSignalSpec,
  PanelTrendPoint,
  PanelTrendsSpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type {
  ExplainPanelChangeInput,
  PanelExplainDimensionResult,
  PanelExplainResult,
  PanelExplainValue,
  PanelMetricTreeNodeValue,
  PanelMetricTreeValues,
  PanelMetricTreeValuesInput,
  PanelSavedMetricTreeValuesInput,
} from '@weldsuite/app-api-client/schemas/weldpanel-analysis';
import type { PanelMetricTreeNode } from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import { DAY_MS, WEBSITE_PROJECT_ID, dailyValue, daysBetween, resolveRange, rng, ymd, type SampleRange } from '../dataset';
import {
  breakdownWeights,
  clamp,
  eventLabel,
  eventVolume,
  filterFactor,
  previousRangeOf,
  resolved,
  round,
  sum,
  uniqueOver,
  uniquePerDay,
} from './query-common';
import { sampleMetricTree } from './collab-definitions';

// ---------------------------------------------------------------------------
// Impact
// ---------------------------------------------------------------------------

/** What a metric measured before the launch: a share for unique users, else a size that fits the maths. */
function impactBaseline(math: string, random: () => number): number {
  if (math === 'unique_users') return 0.34 + random() * 0.12;
  return math === 'avg' ? 42 + random() * 30 : 3.1 + random() * 2;
}

export function impactResult(spec: PanelImpactSpec): PanelImpactResult {
  const projectId = spec.projectId;
  const windowDays = spec.windowDays ?? 28;
  const launch = new Date(`${spec.launchDate}T12:00:00`);
  const todayEnd = new Date();
  const from = ymd(new Date(launch.getTime() - windowDays * DAY_MS));
  const toCandidate = new Date(launch.getTime() + (windowDays - 1) * DAY_MS);
  const to = ymd(toCandidate > todayEnd ? todayEnd : toCandidate);
  const days = daysBetween(from, to);
  const range: SampleRange = { from, to, days, previousFrom: from, previousTo: from };
  const key = `${projectId}|impact|${spec.launchEvent}|${spec.metric.event}`;

  const active = Math.round(uniquePerDay('$pageview', projectId) * 1.1 * filterFactor(spec.filters));
  const eligible = Math.round(active * 3.2);
  const afterLaunch = daysBetween(spec.launchDate, to);
  const dailyAdopters = Math.max(3, uniquePerDay(spec.launchEvent, projectId) * 0.5);
  let adopters = 0;
  const adoption = afterLaunch.map((bucket, i) => {
    const newAdopters = Math.max(1, Math.round(dailyAdopters * (1.8 * Math.exp(-i / 9) + 0.5) * (0.85 + rng(`${key}|a|${bucket}`)() * 0.3)));
    adopters += newAdopters;
    return { bucket, newAdopters, adopters, rate: round(adopters / Math.max(eligible, adopters + 1), 4) };
  });

  const random = rng(key);
  const math = spec.metric.math ?? 'total';
  const share = math === 'unique_users';
  const baseline = impactBaseline(math, random);
  const lift = 1.16 + random() * 0.22;
  const digits = share ? 3 : 2;
  const adoptersBefore = round(baseline * 1.04, digits);
  const adoptersAfter = round(adoptersBefore * lift, digits);
  const otherBefore = round(baseline * 0.98, digits);
  const otherAfter = round(otherBefore * (1.01 + random() * 0.04), digits);
  const did = round(adoptersAfter - adoptersBefore - (otherAfter - otherBefore), digits + 1);

  return {
    range: resolved(range, false, spec.timezone),
    launchDate: spec.launchDate,
    windowDays,
    adoption,
    adopters: { users: adopters, before: adoptersBefore, after: adoptersAfter, change: round(adoptersAfter - adoptersBefore, digits) },
    nonAdopters: { users: Math.max(adopters + 1, eligible - adopters), before: otherBefore, after: otherAfter, change: round(otherAfter - otherBefore, digits) },
    differenceInDifferences: did,
    relativeImpact: adoptersBefore > 0 ? round(did / adoptersBefore, 4) : null,
  };
}

// ---------------------------------------------------------------------------
// Signal
// ---------------------------------------------------------------------------

const SIGNAL_POOL: Array<{ event: string; prevalence: number; lift: number }> = [
  { event: 'invited_teammate', prevalence: 0.11, lift: 3.4 },
  { event: 'watched_demo_video', prevalence: 0.16, lift: 2.5 },
  { event: 'pricing_viewed', prevalence: 0.44, lift: 1.9 },
  { event: 'compared_plans', prevalence: 0.21, lift: 1.7 },
  { event: 'docs_opened', prevalence: 0.19, lift: 1.55 },
  { event: 'read_case_study', prevalence: 0.13, lift: 1.5 },
  { event: 'signup_started', prevalence: 0.2, lift: 4.2 },
  { event: 'used_search', prevalence: 0.18, lift: 1.3 },
  { event: 'newsletter_subscribed', prevalence: 0.07, lift: 1.15 },
  { event: 'clicked_chat_widget', prevalence: 0.1, lift: 1.2 },
  { event: 'cookie_banner_dismissed', prevalence: 0.42, lift: 0.9 },
  { event: 'visited_careers', prevalence: 0.06, lift: 0.5 },
  { event: '$rageclick', prevalence: 0.05, lift: 0.45 },
  { event: 'form_error_shown', prevalence: 0.08, lift: 0.55 },
];

export function signalResult(spec: PanelSignalSpec): PanelSignalResult {
  const projectId = spec.projectId;
  const range = resolveRange(spec.dateRange);
  const windowDays = spec.windowDays ?? 7;
  const users = Math.max(200, Math.round(uniqueOver(uniquePerDay('$pageview', projectId) * filterFactor(spec.filters), range.days.length) * 0.8));
  const goalRate = clamp(eventVolume(spec.goal.event, projectId) / (eventVolume('$pageview', projectId) * 0.4), 0.025, 0.3) * filterFactor(spec.goal.filters) ** 0.2;
  const goalUsers = Math.max(5, Math.round(users * goalRate));
  const names = spec.candidates ?? SIGNAL_POOL.map((c) => c.event).filter((e) => e !== spec.goal.event).slice(0, spec.topN ?? 10);
  const candidates: PanelSignalCandidate[] = names.map((event) => {
    const known = SIGNAL_POOL.find((c) => c.event === event);
    const random = rng(`signal|${projectId}|${event}`);
    const prevalence = known ? known.prevalence : 0.06 + random() * 0.2;
    const lift = known ? known.lift : 0.7 + random() * 1.8;
    const didUsers = Math.max(3, Math.round(users * prevalence));
    const didNotUsers = users - didUsers;
    const didRate = Math.min(0.92, goalRate * lift, (0.9 * goalUsers) / didUsers);
    const didGoal = Math.round(didUsers * didRate);
    const didNotGoal = Math.max(0, goalUsers - didGoal);
    const didNotRate = didNotGoal / Math.max(1, didNotUsers);
    const a = didGoal;
    const b = didUsers - didGoal;
    const c = didNotGoal;
    const d = didNotUsers - didNotGoal;
    const denominator = Math.sqrt((a + b) * (c + d) * (a + c) * (b + d));
    return {
      event,
      didUsers,
      didGoalRate: round(didGoal / didUsers, 4),
      didNotUsers,
      didNotGoalRate: round(didNotRate, 4),
      lift: didNotRate > 0 ? round(didGoal / didUsers / didNotRate, 2) : null,
      correlation: denominator > 0 ? round((a * d - b * c) / denominator, 3) : null,
    };
  });
  candidates.sort((x, y) => Math.abs(y.correlation ?? 0) - Math.abs(x.correlation ?? 0));
  return { range: resolved(range, false, spec.timezone), goal: eventLabel(spec.goal.event), windowDays, users, goalUsers, goalRate: round(goalUsers / users, 4), candidates };
}

// ---------------------------------------------------------------------------
// Explain (root cause)
// ---------------------------------------------------------------------------

const EXPLAIN_DIMENSIONS = ['country', 'device_type', 'browser', 'os', 'referrer_host', 'utm_source', 'path'] as const;

function windowDaysOf(from: string, to: string): string[] {
  return daysBetween(from, to);
}

/** Events a day for a series, by how it counts. */
function perDayOf(math: string, event: string, projectId: string): number {
  if (math === 'unique_users') return uniquePerDay(event, projectId);
  if (math === 'sessions') return eventVolume(event, projectId) * 0.45;
  return math === 'unique_groups' ? eventVolume(event, projectId) * 0.1 : eventVolume(event, projectId);
}

function seriesDaily(spec: PanelTrendsSpec, day: string): number {
  const series = spec.series[0]!;
  const math = series.math ?? 'total';
  const perDay = perDayOf(math, series.event, spec.projectId);
  return dailyValue(`${spec.projectId}|${series.event}|${math}|${series.property ?? ''}`, day, perDay * filterFactor(spec.filters) * filterFactor(series.filters));
}

const HOUR_SHAPE = [1, 0.6, 0.4, 0.3, 0.3, 0.5, 1.2, 2.4, 4.2, 5.6, 6, 5.8, 5.2, 5.6, 5.9, 5.5, 4.8, 4, 3.4, 3.1, 2.9, 2.6, 2, 1.4];

interface ExplainWindows {
  currentFrom: Date;
  currentTo: Date;
  baselineFrom: Date;
  currentValue: number;
  baselineValue: number;
}

function bucketLength(hour: boolean, interval: string): number {
  if (hour) return 3_600_000;
  if (interval === 'week') return 7 * DAY_MS;
  return interval === 'month' ? 30 * DAY_MS : DAY_MS;
}

/** The clicked bucket against the one before it. */
function bucketWindows(spec: PanelTrendsSpec, bucket: string, interval: string): ExplainWindows {
  const hour = bucket.includes('T');
  const start = new Date(hour ? `${bucket}:00` : `${bucket}T00:00:00`);
  const length = bucketLength(hour, interval);
  const currentFrom = start;
  const currentTo = new Date(start.getTime() + length);
  const baselineFrom = new Date(start.getTime() - length);
  if (hour) {
    const share = (h: number): number => (HOUR_SHAPE[h] ?? 1) / sum(HOUR_SHAPE);
    const hourOf = (d: Date): number => d.getHours();
    const currentValue = Math.round(seriesDaily(spec, ymd(currentFrom)) * share(hourOf(currentFrom)));
    const baselineValue = Math.round(seriesDaily(spec, ymd(baselineFrom)) * share(hourOf(baselineFrom)));
    return { currentFrom, currentTo, baselineFrom, currentValue, baselineValue };
  }
  const sumOver = (from: Date, days: number): number => sum(Array.from({ length: days }, (_, i) => seriesDaily(spec, ymd(new Date(from.getTime() + i * DAY_MS)))));
  const days = Math.round(length / DAY_MS);
  return { currentFrom, currentTo, baselineFrom, currentValue: sumOver(currentFrom, days), baselineValue: sumOver(baselineFrom, days) };
}

/** The asked-for period (or the report's range) against the period of the same length before it. */
function periodWindows(spec: PanelTrendsSpec, period: { from: string; to: string } | undefined, range: SampleRange): ExplainWindows {
  const from = period?.from ?? range.from;
  const to = period?.to ?? range.to;
  const days = windowDaysOf(from, to);
  const currentFrom = new Date(`${from}T00:00:00`);
  const currentTo = new Date(new Date(`${to}T00:00:00`).getTime() + DAY_MS);
  const baselineFrom = new Date(currentFrom.getTime() - days.length * DAY_MS);
  const currentValue = sum(days.map((d) => seriesDaily(spec, d)));
  const baselineValue = sum(Array.from({ length: days.length }, (_, i) => seriesDaily(spec, ymd(new Date(baselineFrom.getTime() + i * DAY_MS)))));
  return { currentFrom, currentTo, baselineFrom, currentValue, baselineValue };
}

/** How much of the move one value of a dimension explains: the driver most, the runner-up some, the rest little. */
function driverShareOf(index: number, driverIndex: number, secondary: number, explainedTarget: number): number {
  if (index === driverIndex) return explainedTarget * 0.7;
  return index === secondary ? explainedTarget * 0.3 : 0;
}

function dimensionLabel(b: NonNullable<ExplainPanelChangeInput['properties']>[number]): string {
  const key = 'key' in b ? b.key : '';
  return b.source === 'person' ? `person:${key}` : `event:${key}`;
}

function explainDimension(
  { dimension, weights }: { dimension: string; weights: { value: string; weight: number }[] },
  di: number,
  context: { projectId: string; currentFrom: Date; limit: number; baselineValue: number; change: number },
): PanelExplainDimensionResult {
  const { projectId, currentFrom, limit, baselineValue, change } = context;
  const random = rng(`explain|${projectId}|${dimension}|${currentFrom.toISOString()}`);
  const total = sum(weights.map((w) => w.weight));
  const explainedTarget = clamp(0.78 - di * 0.07 + random() * 0.1, 0.25, 0.88);
  const top = weights.slice(0, Math.max(limit, 4));
  const driverIndex = Math.floor(random() * Math.min(3, top.length));
  const secondary = (driverIndex + 1) % top.length;
  const values: PanelExplainValue[] = top.map((w, i) => {
    const share = w.weight / total;
    const baseline = Math.round(baselineValue * share);
    const driverShare = driverShareOf(i, driverIndex, secondary, explainedTarget);
    const rest = (1 - explainedTarget) * share * (0.8 + random() * 0.4);
    const valueChange = Math.round(change * (driverShare + rest));
    const current = Math.max(0, baseline + valueChange);
    return {
      value: w.value,
      current,
      baseline,
      change: current - baseline,
      changePercent: baseline > 0 ? round((current - baseline) / baseline, 4) : null,
      contributionShare: change !== 0 ? round((current - baseline) / change, 4) : 0,
    };
  });
  const direction = change >= 0 ? 1 : -1;
  values.sort((a, b) => direction * (b.change - a.change));
  const shown = values.slice(0, limit);
  return { dimension, values: shown, explained: clamp(round(sum(shown.map((v) => v.contributionShare)), 3), 0, 1) };
}

function explainNarrative(seriesLabel: string, change: number, baselineValue: number, dimensions: PanelExplainDimensionResult[]): string {
  const top = dimensions[0]?.values[0];
  const verb = change >= 0 ? 'rose' : 'fell';
  const percent = Math.abs(round(baselineValue > 0 ? (change / baselineValue) * 100 : 0, 1));
  const segment = dimensions[0]?.dimension.replace('_', ' ') ?? 'one segment';
  const detail = top ? `: ${top.value} accounts for ${Math.round(top.contributionShare * 100)}% of the change` : '';
  return `${seriesLabel} ${verb} ${percent}% compared with the period before. Most of the move comes from ${segment}${detail}. Other segments moved in line with the overall trend.`;
}

export function explainResult(input: ExplainPanelChangeInput): PanelExplainResult {
  const spec = input.spec;
  const projectId = input.projectId;
  const interval = spec.interval ?? 'day';
  const limit = input.limit ?? 5;
  const range = resolveRange(spec.dateRange);

  const windows = input.bucket ? bucketWindows(spec, input.bucket, interval) : periodWindows(spec, input.period, range);
  const { currentFrom, currentTo, baselineFrom, baselineValue } = windows;
  let { currentValue } = windows;
  // A move worth explaining: if the two windows are close, give the current one a visible step.
  if (Math.abs(currentValue - baselineValue) < Math.max(5, baselineValue * 0.06)) currentValue = Math.round(baselineValue * 1.19);
  const change = currentValue - baselineValue;

  const dimensionKeys: Array<{ dimension: string; weights: { value: string; weight: number }[] }> = [
    ...EXPLAIN_DIMENSIONS.map((field) => ({ dimension: field as string, weights: breakdownWeights({ source: 'column', field }, projectId).map((w) => ({ value: w.value === '' ? '(direct)' : w.value, weight: w.weight })) })),
    ...(input.properties ?? []).map((b) => ({ dimension: dimensionLabel(b), weights: breakdownWeights(b, projectId) })),
  ];

  const dimensions = dimensionKeys.map((keys, di) => explainDimension(keys, di, { projectId, currentFrom, limit, baselineValue, change }));
  dimensions.sort((a, b) => b.explained - a.explained);

  const seriesLabel = spec.series[0]!.label ?? eventLabel(spec.series[0]!.event);
  const narrative = input.narrate ? { text: explainNarrative(seriesLabel, change, baselineValue, dimensions), modelId: 'claude-sonnet-4-5', creditsCharged: 3, cached: false } : null;

  return {
    current: { from: currentFrom.toISOString(), to: currentTo.toISOString() },
    baseline: { from: baselineFrom.toISOString(), to: currentFrom.toISOString() },
    metric: { label: seriesLabel, current: currentValue, baseline: baselineValue, change, changePercent: baselineValue > 0 ? round(change / baselineValue, 4) : null },
    dimensions,
    narrative,
    dataAsOf: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Metric tree values
// ---------------------------------------------------------------------------

/**
 * The nodes of the sample metric tree. The collab area can use these for the
 * saved tree so `POST /metric-tree-values/:id` has values for every node.
 */
export const SAMPLE_METRIC_TREE_NODES: PanelMetricTreeNode[] = (() => {
  const node = (id: string, label: string, parentId: string | null, relation: 'sum' | 'product' | 'influence' | null, event: string, math: 'total' | 'unique_users'): PanelMetricTreeNode => ({
    id,
    label,
    parentId,
    relation,
    metric: { spec: { kind: 'trends', projectId: WEBSITE_PROJECT_ID, dateRange: { preset: '30d' }, interval: 'day', series: [{ event, math, filters: [] }], filters: [] } },
  });
  return [
    node('signups', 'Sign-ups', null, null, 'signup_completed', 'total'),
    node('visitors', 'Unique visitors', 'signups', 'product', '$pageview', 'unique_users'),
    node('started', 'Sign-up forms opened', 'signups', 'product', 'signup_started', 'total'),
    node('trials', 'Trials started', 'signups', 'sum', 'trial_started', 'total'),
    node('demos', 'Demo requests', 'signups', 'sum', 'demo_requested', 'total'),
    node('newsletter', 'Newsletter sign-ups', 'signups', 'influence', 'newsletter_subscribed', 'total'),
  ];
})();

/** Events a day for a metric tree node: from its own spec, or a made-up figure when it points at a saved report. */
function nodePerDay(node: PanelMetricTreeNode, key: string): number {
  if (!('spec' in node.metric)) return 40 + rng(`${key}|report`)() * 300;
  const spec = node.metric.spec;
  const series = spec.series[0]!;
  const volume = (series.math ?? 'total') === 'unique_users' ? uniquePerDay(series.event, spec.projectId) : eventVolume(series.event, spec.projectId);
  return volume * (filterFactor(spec.filters) * filterFactor(series.filters));
}

function nodeSeries(node: PanelMetricTreeNode, range: SampleRange, key: string): { values: number[]; previous: number[] } {
  const previousRange = previousRangeOf(range);
  const perDay = nodePerDay(node, key);
  return {
    values: range.days.map((d) => dailyValue(`${key}|${node.id}`, d, perDay)),
    previous: previousRange.days.map((d) => Math.round(dailyValue(`${key}|${node.id}`, d, perDay) * 0.91)),
  };
}

function metricTreeValues(
  nodes: readonly PanelMetricTreeNode[],
  input: { projectId?: string; dateRange?: PanelSavedMetricTreeValuesInput['dateRange']; timezone?: string },
  key: string,
): PanelMetricTreeValues {
  const range = resolveRange(input.dateRange);
  const values: PanelMetricTreeNodeValue[] = nodes.map((node) => {
    const series = nodeSeries(node, range, `${input.projectId ?? 'saved'}|${key}`);
    const value = sum(series.values);
    const previous = sum(series.previous);
    const points: PanelTrendPoint[] = range.days.map((day, i) => ({ bucket: new Date(`${day}T00:00:00`).toISOString(), value: series.values[i] ?? 0 }));
    const random = rng(`mtree|${key}|${node.id}`);
    return {
      id: node.id,
      label: node.label,
      parentId: node.parentId,
      relation: node.relation,
      value,
      previous,
      changePercent: previous > 0 ? round((value - previous) / previous, 4) : null,
      correlationWithParent: node.relation === 'influence' ? round(0.35 + random() * 0.5, 3) : null,
      points,
      error: null,
    };
  });
  return { range: resolved(range, true, input.timezone), nodes: values, dataAsOf: new Date().toISOString() };
}

export function metricTreePreview(input: PanelMetricTreeValuesInput): PanelMetricTreeValues {
  return metricTreeValues(input.nodes, input, 'preview');
}

export function metricTreeSaved(id: string, input: PanelSavedMetricTreeValuesInput): PanelMetricTreeValues {
  // The saved tree's own nodes (collab area); the stock tree when the id is unknown.
  const nodes = sampleMetricTree(id)?.nodes ?? SAMPLE_METRIC_TREE_NODES;
  return metricTreeValues(nodes, { dateRange: input.dateRange, timezone: input.timezone }, id);
}
