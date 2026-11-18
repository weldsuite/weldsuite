import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import type { PanelTrendsSpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { DATA_AS_OF, RANGE } from '../analytics-fixtures';
import { resetCurrentProjectChoice } from '../lib/use-current-project';
import { makeProject } from '../test-fixtures';
import FrustrationPage from './page';

const state = vi.hoisted(() => ({
  perms: new Set<string>(['panel_recordings:read']),
  specs: [] as { spec: PanelTrendsSpec; options: { enabled?: boolean } | undefined }[],
  overview: { error: null as unknown, isLoading: false, empty: false },
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { interpolate } = await import('@weldsuite/i18n/provider');
  return { useI18n: () => ({ t: english, language: 'en', format: interpolate }) };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.perms.has(key) }));
vi.mock('@/contexts/workspace-context', () => ({ useWorkspaceId: () => 'ws_1' }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('../components/charts/time-series-chart', () => ({
  seriesColor: () => 'red',
  TimeSeriesChart: ({ data }: { data: { label: string }[] }) => <div data-testid="chart">{data.length} points</div>,
}));

const result = (series: { seriesIndex: number; breakdownValue: string | null; total: number }[]) => ({
  result: {
    range: RANGE,
    interval: 'day',
    series: series.map((s) => ({ ...s, label: 'x', points: [{ bucket: '2026-11-13', value: s.total }, { bucket: '2026-11-14', value: 1 }], previous: null })),
  },
  dataAsOf: DATA_AS_OF,
  cached: false,
});

vi.mock('@/hooks/queries/use-weldpanel-queries', () => ({
  useWeldPanelProjects: () => ({ data: [makeProject({ id: 'wpp_1' })], isLoading: false, isError: false, refetch: vi.fn() }),
  useWeldPanelTrends: (spec: PanelTrendsSpec, options?: { enabled?: boolean }) => {
    state.specs.push({ spec, options });
    const base = { error: null, isLoading: false, isFetching: false, refetch: vi.fn() };
    if (spec.breakdown) {
      if (options?.enabled === false) return { ...base, data: undefined };
      return {
        ...base,
        data: result(
          spec.breakdown.source === 'column' && spec.breakdown.field === 'path'
            ? [
                { seriesIndex: 0, breakdownValue: '/pricing', total: 9 },
                { seriesIndex: 0, breakdownValue: '/checkout', total: 20 },
              ]
            : [{ seriesIndex: 0, breakdownValue: '#buy', total: 12 }],
        ),
      };
    }
    if (state.overview.error) return { ...base, data: undefined, error: state.overview.error };
    if (state.overview.isLoading) return { ...base, data: undefined, isLoading: true };
    const totals = state.overview.empty ? [0, 0, 0, 0, 0] : [30, 12, 5, 2, 7];
    return { ...base, data: result(totals.map((total, seriesIndex) => ({ seriesIndex, breakdownValue: null, total }))) };
  },
}));

const tf = en.weldpanel.observe.frustration;
const lastWith = (predicate: (spec: PanelTrendsSpec) => boolean) => [...state.specs].reverse().find((s) => predicate(s.spec))!;

describe('Frustration', () => {
  beforeEach(() => {
    state.perms = new Set(['panel_recordings:read']);
    state.specs = [];
    state.overview = { error: null, isLoading: false, empty: false };
    window.localStorage.clear();
    resetCurrentProjectChoice();
  });

  it('asks for the five frustration events as trends', () => {
    render(<FrustrationPage />);
    const spec = lastWith((s) => !s.breakdown).spec;
    expect(spec.series.map((s) => s.event)).toEqual(['$rageclick', '$deadclick', '$quickback', '$excessivescroll', '$exception']);
    expect(spec.series.every((s) => s.math === 'total')).toBe(true);
  });

  it('shows a count per signal and the trend', () => {
    render(<FrustrationPage />);
    expect(screen.getByRole('button', { name: tf.types.rage }).textContent).toContain('30');
    expect(screen.getByRole('button', { name: tf.types.errors }).textContent).toContain('7');
    expect(screen.getByTestId('chart').textContent).toBe('2 points');
  });

  it('lists the pages with the most rage clicks, biggest first, each linking to its recordings', () => {
    render(<FrustrationPage />);
    const rows = within(screen.getAllByRole('table')[0]!).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual(['/checkout20Watch recordings', '/pricing9Watch recordings']);
    const href = screen.getByRole('link', { name: tf.watchPage.replace('{value}', '/checkout') }).getAttribute('href')!;
    expect(href).toContain('/weldpanel/recordings?');
    expect(href).toContain('frustration=%5B%22rage%22%5D');
    expect(decodeURIComponent(href)).toContain('pages=["/checkout"]');
    expect(href).toContain('project=wpp_1');
  });

  it('lists the elements for click signals', () => {
    render(<FrustrationPage />);
    expect(screen.getByText('#buy')).toBeTruthy();
  });

  it('switches to another signal, asks again for its pages, and drops the elements it does not have', async () => {
    render(<FrustrationPage />);
    await userEvent.click(screen.getByRole('button', { name: tf.types.quickback }));
    expect(lastWith((s) => s.breakdown !== undefined).spec.series[0]!.event).toBe('$quickback');
    expect(lastWith((s) => s.breakdown?.source === 'column' && s.breakdown.field === 'el_selector').options).toMatchObject({ enabled: false });
    expect(screen.getByText(tf.elementsHint)).toBeTruthy();
  });

  it('links the chosen signal to its recordings with the period', async () => {
    render(<FrustrationPage />);
    await userEvent.click(screen.getByRole('button', { name: tf.types.errors }));
    const href = decodeURIComponent(screen.getByRole('link', { name: tf.watch }).getAttribute('href')!);
    expect(href).toContain('errors=true');
    expect(href).toContain('sort=errors_desc');
    expect(href).toContain('range=30d');
  });

  it('does not offer recordings to people who may not watch them', () => {
    state.perms = new Set();
    render(<FrustrationPage />);
    expect(screen.queryByRole('link', { name: tf.watch })).toBeNull();
    expect(screen.getByText(tf.noRecordingsPermission)).toBeTruthy();
  });

  it('shows an empty trend when nothing frustrates anyone', () => {
    state.overview.empty = true;
    render(<FrustrationPage />);
    expect(screen.getByText(tf.trendEmpty)).toBeTruthy();
    expect(screen.queryByTestId('chart')).toBeNull();
  });

  it('shows a skeleton while loading', () => {
    state.overview.isLoading = true;
    render(<FrustrationPage />);
    expect(screen.queryByTestId('chart')).toBeNull();
  });
});
