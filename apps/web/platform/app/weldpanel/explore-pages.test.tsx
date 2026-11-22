/**
 * The new report builders: Stickiness, Lifecycle, Impact, Signal and
 * Performance run the spec they show, draw the result, and open a saved
 * report of their kind.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import { DATA_AS_OF, makeLexicon, makeReport } from './analytics-fixtures';
import { makeGroupType, makeImpactResult, makeLifecycleResult, makeSignalResult, makeStickinessResult, makeVitalsResult } from './explore-fixtures';
import { resetCurrentProjectChoice } from './lib/use-current-project';
import { makeProject } from './test-fixtures';
import ImpactPage from './impact/page';
import LifecyclePage from './lifecycle/page';
import PerformancePage from './performance/page';
import SignalPage from './signal/page';
import StickinessPage from './stickiness/page';

const state = vi.hoisted(() => ({
  search: '',
  report: undefined as unknown,
  groupTypes: [] as unknown[],
  calls: {} as Record<string, unknown[]>,
  results: {} as Record<string, unknown>,
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => true }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_1' }));
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => undefined }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(state.search),
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelProjects: () => ({ data: [makeProject({ id: 'wpp_1' })], isLoading: false, isError: false, refetch: vi.fn() }),
  useWeldPanelLexicon: () => ({ data: makeLexicon() }),
  useWeldPanelCohorts: () => ({ data: [] }),
  useWeldPanelReport: (id: string) => ({ data: id ? state.report : undefined, isLoading: false, isError: false }),
  useCreateWeldPanelReport: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateWeldPanelReport: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useWeldPanelDashboards: () => ({ data: [] }),
  useAddWeldPanelDashboardTile: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/queries/use-weldpanel-analysis-queries', async () => {
  const { analysisHooksMock } = await import('./explore-test-mocks');
  const kind = (name: string) => (spec: unknown, options: unknown) => {
    (state.calls[name] ??= []).push({ spec, options });
    const result = state.results[name];
    return { data: result ? { result, dataAsOf: DATA_AS_OF, cached: false } : undefined, error: null, isLoading: false, isFetching: false, refetch: vi.fn() };
  };
  return analysisHooksMock({
    useWeldPanelGroupTypes: () => ({ data: state.groupTypes }),
    useWeldPanelStickiness: kind('stickiness'),
    useWeldPanelLifecycle: kind('lifecycle'),
    useWeldPanelVitals: kind('vitals'),
    useWeldPanelImpact: kind('impact'),
    useWeldPanelSignal: kind('signal'),
  });
});

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;

const tx = en.weldpanel.explore;
const last = (name: string) => {
  const calls = state.calls[name] ?? [];
  return calls[calls.length - 1] as { spec: Record<string, unknown>; options: { enabled?: boolean } } | undefined;
};

beforeEach(() => {
  state.search = '';
  state.report = undefined;
  state.groupTypes = [];
  state.calls = {};
  state.results = {};
  window.localStorage.clear();
  resetCurrentProjectChoice();
});

describe('Stickiness', () => {
  it('counts active days of a pageview by default and draws the buckets', () => {
    state.results.stickiness = makeStickinessResult();
    render(<StickinessPage />);
    expect(last('stickiness')?.spec).toMatchObject({ kind: 'stickiness', projectId: 'wpp_1', event: '$pageview', interval: 'day', measure: 'intervals' });
    expect(screen.getByText('150 did it at least once')).toBeTruthy();
    expect(screen.getAllByText(tx.stickiness.axis.day).length).toBeGreaterThan(0);
  });

  it('offers "count by" only once the project has group types, and counts groups', async () => {
    const { unmount } = render(<StickinessPage />);
    expect(screen.queryByRole('combobox', { name: tx.countBy.label })).toBeNull();
    unmount();
    state.groupTypes = [makeGroupType()];
    render(<StickinessPage />);
    await userEvent.click(screen.getByRole('combobox', { name: tx.countBy.label }));
    await userEvent.click(await screen.findByRole('option', { name: 'Companies' }));
    expect(last('stickiness')?.spec).toMatchObject({ aggregateBy: { groupType: 'company' } });
  });

  it('opens a saved stickiness report', () => {
    state.search = 'report=wpr_9';
    state.report = makeReport({ id: 'wpr_9', kind: 'stickiness', spec: { kind: 'stickiness', event: 'Signed up', measure: 'count', interval: 'week' } });
    render(<StickinessPage />);
    expect(last('stickiness')?.spec).toMatchObject({ event: 'Signed up', measure: 'count', interval: 'week' });
  });
});

describe('Lifecycle', () => {
  it('shows the totals per status', () => {
    state.results.lifecycle = makeLifecycleResult();
    render(<LifecyclePage />);
    expect(last('lifecycle')?.spec).toMatchObject({ kind: 'lifecycle', event: '$pageview' });
    expect(screen.getAllByText(tx.lifecycle.statuses.resurrecting).length).toBeGreaterThan(0);
    expect(screen.getByText('50')).toBeTruthy();
  });
});

describe('Impact', () => {
  it('waits for the feature event, then shows the difference in differences', async () => {
    render(<ImpactPage />);
    expect(last('impact')?.options).toMatchObject({ enabled: false });
    expect(screen.getByText(tx.impact.completeHint)).toBeTruthy();

    state.results.impact = makeImpactResult();
    await userEvent.click(screen.getByRole('combobox', { name: tx.impact.launchEvent }));
    await userEvent.click(await screen.findByText('Upgraded'));
    expect(last('impact')?.spec).toMatchObject({ kind: 'impact', launchEvent: 'Upgraded', windowDays: 28, metric: { event: '$pageview', math: 'total' } });
    expect(last('impact')?.options).toMatchObject({ enabled: true });
    expect(screen.getByText(tx.impact.differenceInDifferences)).toBeTruthy();
    expect(screen.getByText('+1.3')).toBeTruthy();
    expect(screen.getByText('+65%')).toBeTruthy();
  });
});

describe('Signal', () => {
  it('tests the top events by default and ranks candidates by lift', async () => {
    render(<SignalPage />);
    state.results.signal = makeSignalResult();
    await userEvent.click(screen.getByRole('combobox', { name: tx.signal.goal }));
    await userEvent.click(await screen.findByText('Upgraded'));
    expect(last('signal')?.spec).toMatchObject({ kind: 'signal', goal: { event: 'Upgraded' }, topN: 10, windowDays: 7 });
    expect(last('signal')?.spec.candidates).toBeUndefined();
    expect(screen.getByText('Invited teammate')).toBeTruthy();
    expect(screen.getByText('6.67×')).toBeTruthy();
  });

  it('waits until every added candidate has an event', async () => {
    render(<SignalPage />);
    await userEvent.click(screen.getByRole('combobox', { name: tx.signal.goal }));
    await userEvent.click(await screen.findByText('Upgraded'));
    await userEvent.click(screen.getByRole('button', { name: tx.signal.addCandidate }));
    expect(last('signal')?.options).toMatchObject({ enabled: false });
  });
});

describe('Performance', () => {
  const pathFilter = { source: 'column', field: 'path', operator: 'eq', value: '/pricing' };

  it('lists the pages with their LCP, INP and CLS, and opens a page from its row', async () => {
    state.results.vitals = makeVitalsResult();
    render(<PerformancePage />);
    const metrics = (state.calls.vitals ?? []).map((call) => (call as { spec: { metric: string } }).spec.metric);
    expect(new Set(metrics)).toEqual(new Set(['lcp', 'inp', 'cls']));
    expect(last('vitals')?.spec).toMatchObject({ kind: 'vitals', limit: 50, cleanPaths: false, filters: [] });
    expect(screen.getByText('/pricing')).toBeTruthy();
  });

  it("shows one page's report: LCP at p75 with its rating, score and worst elements", () => {
    state.search = `page=${encodeURIComponent('/pricing')}`;
    state.results.vitals = makeVitalsResult();
    render(<PerformancePage />);
    expect(last('vitals')?.spec).toMatchObject({ kind: 'vitals', metric: 'lcp', percentile: 'p75', filters: [pathFilter] });
    expect(screen.getByRole('heading', { name: '/pricing' })).toBeTruthy();
    expect(screen.getByText('2.34 s')).toBeTruthy();
    expect(screen.getByText('91')).toBeTruthy();
    expect(screen.getByText('img.hero')).toBeTruthy();
    expect(screen.getByRole('button', { name: tx.performance.back })).toBeTruthy();
  });

  it("switches the metric in a page's report", async () => {
    state.search = `page=${encodeURIComponent('/pricing')}`;
    state.results.vitals = makeVitalsResult();
    render(<PerformancePage />);
    await userEvent.click(screen.getByRole('tab', { name: tx.performance.metrics.inp }));
    expect(last('vitals')?.spec).toMatchObject({ metric: 'inp', filters: [pathFilter] });
  });

  it('says how to get web vitals when there are none', () => {
    state.results.vitals = makeVitalsResult({ samples: 0, paths: [] });
    render(<PerformancePage />);
    expect(screen.getByText(tx.performance.noSamplesTitle)).toBeTruthy();
  });
});
