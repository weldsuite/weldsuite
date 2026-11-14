/**
 * Draft state of the report builders (Insights, Funnels, Retention, Flows):
 * a draft is a spec without its project, ready to run when `is*Ready` says so.
 * A saved report's spec is parsed back into a draft with the contract's own
 * schemas, so defaults are filled in the way the server fills them.
 */

import {
  flowsSpecSchema,
  funnelSpecSchema,
  retentionSpecSchema,
  trendsSpecSchema,
  type PanelFlowsSpec,
  type PanelFunnelSpec,
  type PanelRetentionSpec,
  type PanelTrendsSpec,
  type PanelTrendMath,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { browserTimezone } from './date-range';

export type Draft<T> = Omit<T, 'projectId'>;
export type TrendsDraft = Draft<PanelTrendsSpec>;
export type FunnelDraft = Draft<PanelFunnelSpec>;
export type RetentionDraft = Draft<PanelRetentionSpec>;
export type FlowsDraft = Draft<PanelFlowsSpec>;

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

export function isTrendsReady(draft: TrendsDraft): boolean {
  return draft.series.length > 0 && draft.series.every((s) => s.event !== '' && (!needsProperty(s.math ?? 'total') || Boolean(s.property)));
}

export function isFunnelReady(draft: FunnelDraft): boolean {
  return draft.steps.length >= 2 && draft.steps.every((s) => s.event !== '');
}

export function isRetentionReady(draft: RetentionDraft): boolean {
  return draft.firstEvent !== '';
}

export function isFlowsReady(draft: FlowsDraft): boolean {
  return draft.anchor.event !== '';
}

/** A stored spec carries its project; one that lost it still parses, as the project is the page's anyway. */
function withProject(spec: Record<string, unknown>): Record<string, unknown> {
  return typeof spec.projectId === 'string' && spec.projectId !== '' ? spec : { ...spec, projectId: '_' };
}

function withoutProject(spec: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(spec).filter(([key]) => key !== 'projectId'));
}

/** The draft a saved trends report stands for, or null when its spec no longer parses. */
export function trendsDraftFromSpec(spec: Record<string, unknown>): TrendsDraft | null {
  const parsed = trendsSpecSchema.safeParse(withProject(spec));
  return parsed.success ? (withoutProject(parsed.data) as TrendsDraft) : null;
}

export function funnelDraftFromSpec(spec: Record<string, unknown>): FunnelDraft | null {
  const parsed = funnelSpecSchema.safeParse(withProject(spec));
  return parsed.success ? (withoutProject(parsed.data) as FunnelDraft) : null;
}

export function retentionDraftFromSpec(spec: Record<string, unknown>): RetentionDraft | null {
  const parsed = retentionSpecSchema.safeParse(withProject(spec));
  return parsed.success ? (withoutProject(parsed.data) as RetentionDraft) : null;
}

export function flowsDraftFromSpec(spec: Record<string, unknown>): FlowsDraft | null {
  const parsed = flowsSpecSchema.safeParse(withProject(spec));
  return parsed.success ? (withoutProject(parsed.data) as FlowsDraft) : null;
}

/** Letters for series: A, B, C... */
export function seriesLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

/** A starting name for "Save as report": the event, unless it is one of the built-in `$` events. */
export function defaultReportName(event: string | undefined): string {
  return event && !event.startsWith('$') ? event : '';
}
