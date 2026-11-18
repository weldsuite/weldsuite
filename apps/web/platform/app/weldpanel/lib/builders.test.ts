import { describe, expect, it } from 'vitest';
import {
  defaultLaunchDate,
  defaultReportName,
  emptyFlowsDraft,
  emptyFunnelDraft,
  emptyImpactDraft,
  emptyLifecycleDraft,
  emptyRetentionDraft,
  emptySignalDraft,
  emptyStickinessDraft,
  emptyTrendsDraft,
  flowsDraftFromSpec,
  funnelDraftFromSpec,
  impactDraftFromSpec,
  isFlowsReady,
  isFunnelReady,
  isImpactReady,
  isLifecycleReady,
  isRetentionReady,
  isSignalReady,
  isStickinessReady,
  isTrendsReady,
  lifecycleDraftFromSpec,
  retentionDraftFromSpec,
  signalDraftFromSpec,
  stickinessDraftFromSpec,
  trendsDraftFromSpec,
  vitalsDraftFromSpec,
} from './builders';

describe('trends draft', () => {
  it('starts as a pageview count and is ready', () => {
    expect(isTrendsReady(emptyTrendsDraft())).toBe(true);
  });

  it('is not ready with a series without an event', () => {
    const draft = emptyTrendsDraft();
    draft.series.push({ event: '', math: 'total', filters: [] });
    expect(isTrendsReady(draft)).toBe(false);
  });

  it('needs a property for sum, avg, min and max', () => {
    const draft = emptyTrendsDraft();
    draft.series = [{ event: 'Purchased', math: 'sum', filters: [] }];
    expect(isTrendsReady(draft)).toBe(false);
    draft.series = [{ event: 'Purchased', math: 'sum', property: 'amount', filters: [] }];
    expect(isTrendsReady(draft)).toBe(true);
  });

  it('is rebuilt from a saved spec with the server defaults filled in and no project', () => {
    const draft = trendsDraftFromSpec({ kind: 'trends', projectId: 'wpp_1', series: [{ event: 'Signed up' }] });
    expect(draft).not.toBeNull();
    expect(draft).not.toHaveProperty('projectId');
    expect(draft?.interval).toBe('day');
    expect(draft?.series[0]?.math).toBe('total');
  });

  it('is null for a spec that no longer parses', () => {
    expect(trendsDraftFromSpec({ kind: 'trends', series: [] })).toBeNull();
  });
});

describe('funnel draft', () => {
  it('needs an event on every step', () => {
    const draft = emptyFunnelDraft();
    expect(isFunnelReady(draft)).toBe(false);
    draft.steps[1] = { event: 'Signed up', filters: [] };
    expect(isFunnelReady(draft)).toBe(true);
  });

  it('is rebuilt from a saved spec', () => {
    const draft = funnelDraftFromSpec({ kind: 'funnel', projectId: 'wpp_1', steps: [{ event: 'a' }, { event: 'b' }] });
    expect(draft?.window).toEqual({ value: 7, unit: 'day' });
    expect(draft?.order).toBe('loose');
  });
});

describe('retention and flows drafts', () => {
  it('are ready with their event', () => {
    expect(isRetentionReady(emptyRetentionDraft())).toBe(true);
    expect(isFlowsReady(emptyFlowsDraft())).toBe(true);
    expect(isRetentionReady({ ...emptyRetentionDraft(), firstEvent: '' })).toBe(false);
    expect(isFlowsReady({ ...emptyFlowsDraft(), anchor: { event: '', filters: [] } })).toBe(false);
  });

  it('are rebuilt from saved specs', () => {
    expect(retentionDraftFromSpec({ kind: 'retention', projectId: 'wpp_1', firstEvent: 'Signed up' })?.periods).toBe(8);
    expect(flowsDraftFromSpec({ kind: 'flows', projectId: 'wpp_1', anchor: { event: '$pageview' } })?.depth).toBe(3);
  });
});

describe('gaps PR drafts', () => {
  it('open a report saved with one breakdown with it in the list of breakdowns', () => {
    const draft = trendsDraftFromSpec({ kind: 'trends', projectId: 'wpp_1', series: [{ event: 'a' }], breakdown: { source: 'column', field: 'country' } });
    expect(draft).not.toHaveProperty('breakdown');
    expect(draft?.breakdowns).toEqual([{ source: 'column', field: 'country', limit: 10 }]);
    expect(funnelDraftFromSpec({ kind: 'funnel', projectId: 'wpp_1', steps: [{ event: 'a' }, { event: 'b' }] })?.breakdowns).toBeUndefined();
  });

  it('need a group type to count unique groups', () => {
    const draft = emptyTrendsDraft();
    draft.series = [{ event: 'a', math: 'unique_groups', filters: [] }];
    expect(isTrendsReady(draft)).toBe(false);
    draft.series = [{ event: 'a', math: 'unique_groups', groupType: 'company', filters: [] }];
    expect(isTrendsReady(draft)).toBe(true);
  });

  it('a funnel waits for complete exclusions inside its steps', () => {
    const draft = { ...emptyFunnelDraft(), steps: [{ event: 'a', filters: [] }, { event: 'b', filters: [] }], exclusions: [{ event: '', filters: [], fromStep: 0, toStep: 1 }] };
    expect(isFunnelReady(draft)).toBe(false);
    draft.exclusions = [{ event: 'x', filters: [], fromStep: 0, toStep: 1 }];
    expect(isFunnelReady(draft)).toBe(true);
  });

  it('new kinds are ready with their events and rebuilt from saved specs', () => {
    expect(isStickinessReady(emptyStickinessDraft())).toBe(true);
    expect(isLifecycleReady(emptyLifecycleDraft())).toBe(true);
    expect(isImpactReady(emptyImpactDraft())).toBe(false);
    expect(isImpactReady({ ...emptyImpactDraft(), launchEvent: 'Used export', metric: { event: 'Paid', math: 'sum', filters: [] } })).toBe(false);
    expect(isImpactReady({ ...emptyImpactDraft(), launchEvent: 'Used export', metric: { event: 'Paid', math: 'sum', property: 'amount', filters: [] } })).toBe(true);
    expect(isSignalReady(emptySignalDraft())).toBe(false);
    expect(isSignalReady({ ...emptySignalDraft(), goal: { event: 'Upgraded', filters: [] }, candidates: [''] })).toBe(false);
    expect(stickinessDraftFromSpec({ kind: 'stickiness', projectId: 'wpp_1', event: 'a' })?.measure).toBe('intervals');
    expect(lifecycleDraftFromSpec({ kind: 'lifecycle', event: 'a' })?.interval).toBe('day');
    expect(vitalsDraftFromSpec({ kind: 'vitals', projectId: 'wpp_1' })?.percentile).toBe('p75');
    expect(impactDraftFromSpec({ kind: 'impact', projectId: 'wpp_1', launchEvent: 'a', launchDate: '2026-10-01', metric: { event: 'b' } })?.windowDays).toBe(28);
    expect(signalDraftFromSpec({ kind: 'signal', projectId: 'wpp_1', goal: { event: 'a' } })?.topN).toBe(10);
  });

  it('suggest a launch date four weeks back and leave custom event refs out of report names', () => {
    expect(defaultLaunchDate(new Date(2026, 10, 30))).toBe('2026-11-02');
    expect(defaultReportName('@pnce_abc')).toBe('');
  });
});
