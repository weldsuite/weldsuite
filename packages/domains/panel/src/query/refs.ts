/**
 * What a parsed spec refers to besides its own fields: saved cohorts, custom
 * events (`@pnce_…`), computed properties (`@pncp_…`), group types, and
 * whether it groups by path (so the path rules matter). panel-api loads only
 * these into the {@link PanelQueryContext}, like it does cohorts.
 */

import {
  aggregateGroupType,
  isComputedPropertyRef,
  isCustomEventRef,
  specBreakdowns,
  type PanelBreakdown,
  type PanelFilter,
  type ParsedPanelQuerySpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { ParsedPanelCustomEventDefinition } from '@weldsuite/app-api-client/schemas/weldpanel-collab';

export interface SpecReferences {
  cohortIds: string[];
  /** Row ids (`pnce_…`, without the `@`). */
  customEventIds: string[];
  /** Row ids (`pncp_…`). Computed properties used inside custom events are added by {@link customEventReferences}. */
  computedPropertyIds: string[];
  groupTypes: string[];
  /** The spec groups or shows pages by path and has not switched path cleaning off. */
  usesPathRules: boolean;
}

interface Collector {
  cohorts: Set<string>;
  customEvents: Set<string>;
  computed: Set<string>;
  groups: Set<string>;
}

function collector(): Collector {
  return { cohorts: new Set(), customEvents: new Set(), computed: new Set(), groups: new Set() };
}

function addEvent(c: Collector, ref: string | undefined): void {
  if (ref && isCustomEventRef(ref)) c.customEvents.add(ref.slice(1));
}

function addProperty(c: Collector, key: string | undefined): void {
  if (key && isComputedPropertyRef(key)) c.computed.add(key.slice(1));
}

function addFilters(c: Collector, filters: readonly PanelFilter[] | undefined): void {
  for (const f of filters ?? []) {
    if (f.source === 'cohort') c.cohorts.add(f.cohortId);
    if (f.source === 'event') addProperty(c, f.key);
    if (f.source === 'group' || f.source === 'group_key') c.groups.add(f.groupType);
  }
}

function addBreakdowns(c: Collector, breakdowns: readonly (PanelBreakdown | undefined)[]): void {
  for (const b of breakdowns) {
    if (b?.source === 'event') addProperty(c, b.key);
    if (b?.source === 'group') c.groups.add(b.groupType);
  }
}

function pathBreakdown(breakdowns: readonly (PanelBreakdown | undefined)[]): boolean {
  return breakdowns.some((b) => b?.source === 'column' && b.field === 'path');
}

/** Events with their own filters (steps, exclusions, goals, anchors). */
function addEventsWithFilters(c: Collector, items: readonly { event?: string; filters: readonly PanelFilter[] }[]): void {
  for (const item of items) {
    addEvent(c, item.event);
    addFilters(c, item.filters);
  }
}

type Kind = ParsedPanelQuerySpec['kind'];
type SpecOf<K extends Kind> = Extract<ParsedPanelQuerySpec, { kind: K }>;

/** Per kind: add what the spec refers to, and say whether it groups or shows pages by path. */
const COLLECTORS: { [K in Kind]: (c: Collector, spec: SpecOf<K>) => boolean } = {
  web: (c, spec) => {
    addEventsWithFilters(c, spec.goals ?? []);
    return spec.panels === undefined || spec.panels.includes('topPages') || spec.panels.includes('entryExitPages');
  },
  trends: (c, spec) => {
    addEventsWithFilters(c, spec.series);
    for (const s of spec.series) {
      addProperty(c, s.property);
      if (s.math === 'unique_groups' && s.groupType) c.groups.add(s.groupType);
    }
    const breakdowns = specBreakdowns(spec);
    addBreakdowns(c, breakdowns);
    return pathBreakdown(breakdowns);
  },
  funnel: (c, spec) => funnelReferences(c, spec),
  funnel_correlation: (c, spec) => funnelReferences(c, spec),
  retention: (c, spec) => {
    addEvent(c, spec.firstEvent);
    addEvent(c, spec.returnEvent);
    addBreakdowns(c, [spec.breakdown]);
    return pathBreakdown([spec.breakdown]);
  },
  flows: (c, spec) => {
    addEventsWithFilters(c, [spec.anchor]);
    return true;
  },
  sessions: (c, spec) => {
    if (spec.cohortId) c.cohorts.add(spec.cohortId);
    for (const ref of [...(spec.didEvents ?? []), ...(spec.notDidEvents ?? [])]) addEvent(c, ref);
    return false;
  },
  heatmap: () => false,
  stickiness: (c, spec) => {
    addEvent(c, spec.event);
    return false;
  },
  lifecycle: (c, spec) => {
    addEvent(c, spec.event);
    return false;
  },
  vitals: () => true,
  impact: (c, spec) => {
    addEvent(c, spec.launchEvent);
    addEventsWithFilters(c, [spec.metric]);
    addProperty(c, spec.metric.property);
    return false;
  },
  signal: (c, spec) => {
    addEventsWithFilters(c, [spec.goal]);
    for (const ref of spec.candidates ?? []) addEvent(c, ref);
    return false;
  },
};

function funnelReferences(c: Collector, spec: SpecOf<'funnel'> | SpecOf<'funnel_correlation'>): boolean {
  addEventsWithFilters(c, [...spec.steps, ...(spec.exclusions ?? [])]);
  const breakdowns = [...specBreakdowns(spec), spec.holdConstant];
  addBreakdowns(c, breakdowns);
  return pathBreakdown(breakdowns);
}

/** Everything a spec refers to. */
export function specReferences(spec: ParsedPanelQuerySpec): SpecReferences {
  const c = collector();
  if ('filters' in spec) addFilters(c, spec.filters);
  const collect = COLLECTORS[spec.kind] as (c: Collector, spec: ParsedPanelQuerySpec) => boolean;
  const usesPaths = collect(c, spec);

  if ('aggregateBy' in spec) {
    const type = aggregateGroupType(spec.aggregateBy);
    if (type) c.groups.add(type);
  }
  const cleanPaths = 'cleanPaths' in spec ? spec.cleanPaths : undefined;
  return {
    cohortIds: [...c.cohorts],
    customEventIds: [...c.customEvents],
    computedPropertyIds: [...c.computed],
    groupTypes: [...c.groups].sort(),
    usesPathRules: usesPaths && cleanPaths !== false,
  };
}

/** What loaded custom events refer to in turn: computed properties and group types in their filters. */
export function customEventReferences(definitions: readonly ParsedPanelCustomEventDefinition[]): { computedPropertyIds: string[]; groupTypes: string[] } {
  const c = collector();
  for (const def of definitions) for (const m of def.match) addFilters(c, m.filters as readonly PanelFilter[]);
  return { computedPropertyIds: [...c.computed], groupTypes: [...c.groups].sort() };
}
