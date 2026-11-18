/**
 * Draft state of the report builders (Insights, Funnels, Retention, Flows,
 * Stickiness, Lifecycle, Performance, Impact, Signal): a draft is a spec
 * without its project, ready to run when `is*Ready` says so. A saved report's
 * spec is parsed back into a draft with the contract's own schemas, so
 * defaults are filled in the way the server fills them, and a report saved
 * before multiple breakdowns existed (`breakdown`) opens with that one in
 * `breakdowns`.
 */

import {
  flowsSpecSchema,
  funnelSpecSchema,
  impactSpecSchema,
  lifecycleSpecSchema,
  retentionSpecSchema,
  signalSpecSchema,
  specBreakdowns,
  stickinessSpecSchema,
  trendsSpecSchema,
  vitalsSpecSchema,
  type PanelFlowsSpec,
  type PanelFunnelSpec,
  type PanelImpactSpec,
  type PanelLifecycleSpec,
  type PanelRetentionSpec,
  type PanelSignalSpec,
  type PanelStickinessSpec,
  type PanelTrendsSpec,
  type PanelTrendMath,
  type PanelVitalsSpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { browserTimezone } from './date-range';

export type Draft<T> = Omit<T, 'projectId'>;
export type TrendsDraft = Draft<PanelTrendsSpec>;
export type FunnelDraft = Draft<PanelFunnelSpec>;
export type RetentionDraft = Draft<PanelRetentionSpec>;
export type FlowsDraft = Draft<PanelFlowsSpec>;
export type StickinessDraft = Draft<PanelStickinessSpec>;
export type LifecycleDraft = Draft<PanelLifecycleSpec>;
export type VitalsDraft = Draft<PanelVitalsSpec>;
export type ImpactDraft = Draft<PanelImpactSpec>;
export type SignalDraft = Draft<PanelSignalSpec>;

export const PROPERTY_MATHS: readonly PanelTrendMath[] = ['sum', 'avg', 'min', 'max'];

export function needsProperty(math: PanelTrendMath): boolean {
  return PROPERTY_MATHS.includes(math);
}

export function emptyTrendsDraft(): TrendsDraft {
  return { kind: 'trends', series: [{ event: '$pageview', math: 'total', filters: [] }], interval: 'day', compare: false, filters: [], dateRange: { preset: '30d' }, timezone: browserTimezone() };
}

export function emptyFunnelDraft(): FunnelDraft {
  return {
    kind: 'funnel',
    steps: [
      { event: '$pageview', filters: [] },
      { event: '', filters: [] },
    ],
    window: { value: 7, unit: 'day' },
    order: 'loose',
    filters: [],
    dateRange: { preset: '30d' },
    timezone: browserTimezone(),
  };
}

export function emptyRetentionDraft(): RetentionDraft {
  return { kind: 'retention', firstEvent: '$pageview', interval: 'week', periods: 8, filters: [], dateRange: { preset: '90d' }, timezone: browserTimezone() };
}

export function emptyFlowsDraft(): FlowsDraft {
  return { kind: 'flows', anchor: { event: '$pageview', filters: [] }, direction: 'after', depth: 3, scope: 'all', limit: 20, filters: [], dateRange: { preset: '30d' }, timezone: browserTimezone() };
}

export function emptyStickinessDraft(): StickinessDraft {
  return { kind: 'stickiness', event: '$pageview', interval: 'day', measure: 'intervals', filters: [], dateRange: { preset: '30d' }, timezone: browserTimezone() };
}

export function emptyLifecycleDraft(): LifecycleDraft {
  return { kind: 'lifecycle', event: '$pageview', interval: 'week', filters: [], dateRange: { preset: '90d' }, timezone: browserTimezone() };
}

export function emptyVitalsDraft(): VitalsDraft {
  return { kind: 'vitals', metric: 'lcp', percentile: 'p75', interval: 'day', limit: 10, filters: [], dateRange: { preset: '30d' }, timezone: browserTimezone() };
}

/** Four weeks ago, local time: a launch date with a full window on both sides. */
export function defaultLaunchDate(now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 28);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function emptyImpactDraft(): ImpactDraft {
  return {
    kind: 'impact',
    launchEvent: '',
    launchDate: defaultLaunchDate(),
    metric: { event: '$pageview', math: 'total', filters: [] },
    windowDays: 28,
    filters: [],
    dateRange: { preset: '90d' },
    timezone: browserTimezone(),
  };
}

export function emptySignalDraft(): SignalDraft {
  return { kind: 'signal', goal: { event: '', filters: [] }, topN: 10, windowDays: 7, filters: [], dateRange: { preset: '30d' }, timezone: browserTimezone() };
}

export function isTrendsReady(draft: TrendsDraft): boolean {
  return (
    draft.series.length > 0 &&
    draft.series.every((s) => s.event !== '' && (!needsProperty(s.math ?? 'total') || Boolean(s.property)) && (s.math !== 'unique_groups' || Boolean(s.groupType)))
  );
}

export function isFunnelReady(draft: FunnelDraft): boolean {
  return draft.steps.length >= 2 && draft.steps.every((s) => s.event !== '') && (draft.exclusions ?? []).every((x) => x.event !== '' && x.fromStep < x.toStep && x.toStep < draft.steps.length);
}

export function isRetentionReady(draft: RetentionDraft): boolean {
  return draft.firstEvent !== '';
}

export function isFlowsReady(draft: FlowsDraft): boolean {
  return draft.anchor.event !== '';
}

export function isStickinessReady(draft: StickinessDraft): boolean {
  return draft.event !== '';
}

export function isLifecycleReady(draft: LifecycleDraft): boolean {
  return draft.event !== '';
}

export function isImpactReady(draft: ImpactDraft): boolean {
  const math = draft.metric.math ?? 'total';
  return draft.launchEvent !== '' && draft.metric.event !== '' && /^\d{4}-\d{2}-\d{2}$/.test(draft.launchDate) && (!['sum', 'avg'].includes(math) || Boolean(draft.metric.property));
}

export function isSignalReady(draft: SignalDraft): boolean {
  return draft.goal.event !== '' && (draft.candidates ?? []).every((c) => c !== '');
}

/** A stored spec carries its project; one that lost it still parses, as the project is the page's anyway. */
function withProject(spec: Record<string, unknown>): Record<string, unknown> {
  return typeof spec.projectId === 'string' && spec.projectId !== '' ? spec : { ...spec, projectId: '_' };
}

function withoutProject(spec: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(spec).filter(([key]) => key !== 'projectId'));
}

/** `breakdown` (one, saved before several were possible) moves into `breakdowns`. */
function withBreakdownList<T extends { breakdown?: unknown; breakdowns?: unknown }>(draft: T): T {
  const list = specBreakdowns(draft as Parameters<typeof specBreakdowns>[0]);
  const rest = Object.fromEntries(Object.entries(draft).filter(([key]) => key !== 'breakdown'));
  return { ...rest, breakdowns: list.length > 0 ? list : undefined } as T;
}

/** The draft a saved trends report stands for, or null when its spec no longer parses. */
export function trendsDraftFromSpec(spec: Record<string, unknown>): TrendsDraft | null {
  const parsed = trendsSpecSchema.safeParse(withProject(spec));
  return parsed.success ? withBreakdownList(withoutProject(parsed.data) as TrendsDraft) : null;
}

export function funnelDraftFromSpec(spec: Record<string, unknown>): FunnelDraft | null {
  const parsed = funnelSpecSchema.safeParse(withProject(spec));
  return parsed.success ? withBreakdownList(withoutProject(parsed.data) as FunnelDraft) : null;
}

export function retentionDraftFromSpec(spec: Record<string, unknown>): RetentionDraft | null {
  const parsed = retentionSpecSchema.safeParse(withProject(spec));
  return parsed.success ? (withoutProject(parsed.data) as RetentionDraft) : null;
}

export function flowsDraftFromSpec(spec: Record<string, unknown>): FlowsDraft | null {
  const parsed = flowsSpecSchema.safeParse(withProject(spec));
  return parsed.success ? (withoutProject(parsed.data) as FlowsDraft) : null;
}

export function stickinessDraftFromSpec(spec: Record<string, unknown>): StickinessDraft | null {
  const parsed = stickinessSpecSchema.safeParse(withProject(spec));
  return parsed.success ? (withoutProject(parsed.data) as StickinessDraft) : null;
}

export function lifecycleDraftFromSpec(spec: Record<string, unknown>): LifecycleDraft | null {
  const parsed = lifecycleSpecSchema.safeParse(withProject(spec));
  return parsed.success ? (withoutProject(parsed.data) as LifecycleDraft) : null;
}

export function vitalsDraftFromSpec(spec: Record<string, unknown>): VitalsDraft | null {
  const parsed = vitalsSpecSchema.safeParse(withProject(spec));
  return parsed.success ? (withoutProject(parsed.data) as VitalsDraft) : null;
}

export function impactDraftFromSpec(spec: Record<string, unknown>): ImpactDraft | null {
  const parsed = impactSpecSchema.safeParse(withProject(spec));
  return parsed.success ? (withoutProject(parsed.data) as ImpactDraft) : null;
}

export function signalDraftFromSpec(spec: Record<string, unknown>): SignalDraft | null {
  const parsed = signalSpecSchema.safeParse(withProject(spec));
  return parsed.success ? (withoutProject(parsed.data) as SignalDraft) : null;
}

/** Letters for series: A, B, C... */
export function seriesLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

/** A starting name for "Save as report": the event, unless it is one of the built-in `$` events or a custom event ref. */
export function defaultReportName(event: string | undefined): string {
  return event && !event.startsWith('$') && !event.startsWith('@') ? event : '';
}
