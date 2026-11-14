import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { ApiError } from '@weldsuite/api-client';
import { en } from '@weldsuite/i18n/locales/en';
import type { PanelTrendsSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { DATA_AS_OF, makeLexicon, makeReport, makeTrendsResult } from '../analytics-fixtures';
import { resetCurrentProjectChoice } from '../lib/use-current-project';
import { makeProject } from '../test-fixtures';
import InsightsPage from './page';

const state = vi.hoisted(() => ({
  search: '',
  trends: { data: undefined as unknown, error: null as unknown, isLoading: false, isFetching: false, refetch: vi.fn() },
  trendsCalls: [] as { spec: unknown; options: unknown }[],
  report: undefined as unknown,
  create: vi.fn(),
  update: vi.fn(),
  replace: vi.fn(),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => true }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_1' }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: state.replace }),
  useSearchParams: () => new URLSearchParams(state.search),
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelProjects: () => ({ data: [makeProject({ id: 'wpp_1' })], isLoading: false, isError: false, refetch: vi.fn() }),
  useWeldPanelTrends: (spec: unknown, options: unknown) => {
    state.trendsCalls.push({ spec, options });
    return state.trends;
  },
  useWeldPanelLexicon: () => ({ data: makeLexicon() }),
  useWeldPanelCohorts: () => ({ data: [] }),
  useWeldPanelReport: (id: string) => ({ data: id ? state.report : undefined, isLoading: false, isError: false }),
  useCreateWeldPanelReport: () => ({ mutateAsync: state.create, isPending: false }),
  useUpdateWeldPanelReport: () => ({ mutateAsync: state.update, isPending: false }),
  useWeldPanelDashboards: () => ({ data: [] }),
  useAddWeldPanelDashboardTile: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// Radix Select reads pointer capture, which jsdom lacks.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => undefined;
Element.prototype.releasePointerCapture ??= () => undefined;

const ti = en.weldpanel.analytics.insights;

const lastCall = () => state.trendsCalls[state.trendsCalls.length - 1]!;
const lastSpec = () => lastCall().spec as PanelTrendsSpec;

describe('Insights', () => {
  beforeEach(() => {
    state.search = '';
    state.trends = { data: { result: makeTrendsResult(), dataAsOf: DATA_AS_OF, cached: false }, error: null, isLoading: false, isFetching: false, refetch: vi.fn() };
    state.trendsCalls = [];
    state.report = undefined;
    state.create.mockReset();
    state.update.mockReset();
    state.replace.mockReset();
    window.localStorage.clear();
    resetCurrentProjectChoice();
  });

  it('starts with a pageview count over the last 30 days and runs it', () => {
    render(<InsightsPage />);
    expect(lastSpec()).toMatchObject({
      kind: 'trends',
      projectId: 'wpp_1',
      dateRange: { preset: '30d' },
      interval: 'day',
      compare: false,
      series: [{ event: '$pageview', math: 'total' }],
    });
    expect(lastCall().options).toMatchObject({ enabled: true });
  });

  it('adds a series without an event, and waits for one before running', async () => {
    render(<InsightsPage />);
    await userEvent.click(screen.getByRole('button', { name: ti.addSeries }));
    expect(lastSpec().series).toHaveLength(2);
    expect(lastCall().options).toMatchObject({ enabled: false });
    expect(screen.getByText(ti.completeHint)).toBeTruthy();
  });

  it('removes a series', async () => {
    render(<InsightsPage />);
    await userEvent.click(screen.getByRole('button', { name: ti.addSeries }));
    await userEvent.click(screen.getByRole('button', { name: ti.removeSeries.replace('{letter}', 'B') }));
    expect(lastSpec().series).toHaveLength(1);
  });

  it('picks an event from the lexicon and keeps hidden names out of the list', async () => {
    render(<InsightsPage />);
    await userEvent.click(screen.getByRole('combobox', { name: `${ti.event} A` }));
    expect(await screen.findByText('Upgraded')).toBeTruthy();
    expect(screen.queryByText('Debug ping')).toBeNull();
    await userEvent.click(screen.getByText('Signed up'));
    expect(lastSpec().series[0]?.event).toBe('Signed up');
  });

  it('lets a valid event name be typed that nobody sent yet', async () => {
    render(<InsightsPage />);
    await userEvent.click(screen.getByRole('combobox', { name: `${ti.event} A` }));
    await userEvent.type(await screen.findByPlaceholderText(en.weldpanel.analytics.pickers.eventSearch), 'Brand new');
    await userEvent.click(await screen.findByText('Use "Brand new"'));
    expect(lastSpec().series[0]?.event).toBe('Brand new');
  });

  it('needs a property for a sum before it runs', async () => {
    render(<InsightsPage />);
    await userEvent.click(screen.getByRole('combobox', { name: ti.measure }));
    await userEvent.click(await screen.findByRole('option', { name: ti.measures.sum }));
    expect(lastCall().options).toMatchObject({ enabled: false });
    await userEvent.click(screen.getByRole('combobox', { name: `${ti.measureProperty} A` }));
    await userEvent.click(await screen.findByText('plan'));
    expect(lastSpec().series[0]).toMatchObject({ math: 'sum', property: 'plan' });
    expect(lastCall().options).toMatchObject({ enabled: true });
  });

  it('compares with the previous period', async () => {
    render(<InsightsPage />);
    await userEvent.click(screen.getByRole('switch', { name: en.weldpanel.analytics.range.compare }));
    expect(lastSpec().compare).toBe(true);
  });

  it('shows the result as a table with the change against the previous period', async () => {
    render(<InsightsPage />);
    await userEvent.click(screen.getByRole('radio', { name: ti.chartTypes.table }));
    const table = screen.getByRole('table');
    expect(within(table).getByText('Signed up')).toBeTruthy();
    expect(within(table).getByText('120')).toBeTruthy();
    expect(within(table).getByText('+20%')).toBeTruthy();
  });

  it('shows the result as a big number', async () => {
    render(<InsightsPage />);
    await userEvent.click(screen.getByRole('radio', { name: ti.chartTypes.number }));
    expect(screen.getByText('120')).toBeTruthy();
  });

  it('shows how fresh the result is', () => {
    render(<InsightsPage />);
    expect(screen.getByText(/Data as of/)).toBeTruthy();
  });

  it('shows a calm notice when analytics is not configured', () => {
    state.trends = { data: undefined, error: new ApiError('unavailable', 503), isLoading: false, isFetching: false, refetch: vi.fn() };
    render(<InsightsPage />);
    expect(screen.getByText(en.weldpanel.analytics.errors.notConfiguredTitle)).toBeTruthy();
  });

  it('saves the analysis as a report and opens it', async () => {
    state.create.mockResolvedValue(makeReport({ id: 'wpr_new' }));
    render(<InsightsPage />);
    await userEvent.click(screen.getByRole('button', { name: en.weldpanel.analytics.save.saveReport }));
    const dialog = await screen.findByRole('dialog', { name: en.weldpanel.analytics.save.reportDialogTitle });
    await userEvent.type(within(dialog).getByLabelText(en.weldpanel.analytics.save.nameLabel), 'Pageviews');
    await userEvent.click(within(dialog).getByRole('button', { name: en.weldpanel.analytics.save.saveReport }));
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    expect(state.create.mock.calls[0]?.[0]).toMatchObject({ projectId: 'wpp_1', name: 'Pageviews', visibility: 'private', spec: { kind: 'trends' } });
    await waitFor(() => expect(state.replace).toHaveBeenCalledWith('/weldpanel/insights?report=wpr_new'));
  });

  it('saves the chart type with the report, without sending it to the query', async () => {
    state.create.mockResolvedValue(makeReport({ id: 'wpr_new' }));
    render(<InsightsPage />);
    await userEvent.click(screen.getByRole('radio', { name: ti.chartTypes.bar }));
    expect(lastSpec().display).toBeUndefined();
    await userEvent.click(screen.getByRole('button', { name: en.weldpanel.analytics.save.saveReport }));
    const dialog = await screen.findByRole('dialog', { name: en.weldpanel.analytics.save.reportDialogTitle });
    await userEvent.type(within(dialog).getByLabelText(en.weldpanel.analytics.save.nameLabel), 'Pageviews');
    await userEvent.click(within(dialog).getByRole('button', { name: en.weldpanel.analytics.save.saveReport }));
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    expect(state.create.mock.calls[0]?.[0]).toMatchObject({ spec: { kind: 'trends', display: 'bar' } });
  });

  it('asks for a name before saving', async () => {
    render(<InsightsPage />);
    await userEvent.click(screen.getByRole('button', { name: en.weldpanel.analytics.save.saveReport }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: en.weldpanel.analytics.save.saveReport }));
    expect(await screen.findByText(en.weldpanel.analytics.save.nameRequired)).toBeTruthy();
    expect(state.create).not.toHaveBeenCalled();
  });

  describe('opened from a saved report', () => {
    beforeEach(() => {
      state.search = 'report=wpr_1';
      state.report = makeReport({
        spec: { kind: 'trends', projectId: 'wpp_1', series: [{ event: 'Upgraded', math: 'unique_users', filters: [] }], interval: 'week', compare: true, dateRange: { preset: '90d' } },
      });
    });

    it('loads the report into the builder', async () => {
      render(<InsightsPage />);
      await waitFor(() => expect(lastSpec().series[0]).toMatchObject({ event: 'Upgraded', math: 'unique_users' }));
      expect(lastSpec()).toMatchObject({ interval: 'week', compare: true, dateRange: { preset: '90d' } });
      expect(screen.getByText(ti.editing.replace('{name}', 'Weekly signups'))).toBeTruthy();
    });

    it('reopens with the chart type it was saved with', async () => {
      state.report = makeReport({
        spec: { kind: 'trends', projectId: 'wpp_1', series: [{ event: 'Upgraded', math: 'total', filters: [] }], display: 'table', dateRange: { preset: '30d' } },
      });
      render(<InsightsPage />);
      await waitFor(() => expect(screen.getByRole('radio', { name: ti.chartTypes.table }).getAttribute('data-state')).toBe('on'));
      expect(screen.getByRole('table')).toBeTruthy();
      expect(lastSpec().display).toBeUndefined();
    });

    it('saves changes to the report it was opened with', async () => {
      state.update.mockResolvedValue(makeReport());
      render(<InsightsPage />);
      await waitFor(() => expect(lastSpec().series[0]?.event).toBe('Upgraded'));
      await userEvent.click(screen.getByRole('button', { name: en.weldpanel.analytics.save.updateReport }));
      await waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
      expect(state.update.mock.calls[0]?.[0]).toMatchObject({ spec: { kind: 'trends', series: [{ event: 'Upgraded' }] } });
    });

    it('points to the right builder for a report of another kind', () => {
      state.report = makeReport({ kind: 'funnel', spec: { kind: 'funnel' } });
      render(<InsightsPage />);
      expect(screen.getByRole('link', { name: en.weldpanel.analytics.common.open }).getAttribute('href')).toBe('/weldpanel/funnels?report=wpr_1');
    });
  });
});
