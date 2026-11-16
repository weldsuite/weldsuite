import { describe, expect, it } from 'vitest';
import { funnelDraftFromSpec, emptyFunnelDraft, emptyTrendsDraft, isFlowsReady, isFunnelReady, isRetentionReady, isTrendsReady, emptyFlowsDraft, emptyRetentionDraft, trendsDraftFromSpec, retentionDraftFromSpec, flowsDraftFromSpec } from './builders';

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
