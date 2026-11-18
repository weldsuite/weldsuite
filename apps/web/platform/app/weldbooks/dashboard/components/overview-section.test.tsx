import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';
import type { Dashboard } from '@/lib/api/domains/weldbooks';
import { DEFAULT_CHARTS, type DashboardChart } from './custom-charts';

const push = vi.fn();
const charts = {
  charts: DEFAULT_CHARTS.slice(0, 3) as DashboardChart[],
  setCharts: vi.fn(),
  removeChart: vi.fn(),
  restoreChart: vi.fn(),
  isSaving: false,
};
const toastError = vi.fn();

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: english, language: 'en' }) };
});
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/hooks/queries/use-weldbooks-dashboard-charts', () => ({ useDashboardCharts: () => charts }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: (...args: unknown[]) => toastError(...args) } }));
vi.mock('@/components/entity-list', () => ({
  EmptyStateIllustration: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
// The cards draw Recharts; only which charts are listed, and taking one off, matter here.
vi.mock('./custom-chart-card', () => ({
  CustomChartCard: ({ chart }: { chart: DashboardChart }) => <div data-testid="chart">{chart.id}</div>,
  SortableChartCard: ({ chart, onRemove }: { chart: DashboardChart; onRemove: () => void }) => (
    <button type="button" onClick={onRemove}>
      remove {chart.id}
    </button>
  ),
}));
vi.mock('./dashboard-series', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./dashboard-series')>()),
  dashboardTrend: () => ({ months: [], sample: false }),
}));

import { CHART_BUILDER_PATH, OverviewSection } from './overview-section';

const tc = en.accounting.dashboard.charts;
const tb = en.accounting.dashboard.builder;

function renderOverview() {
  render(<OverviewSection dashboard={{} as Dashboard} />);
}

/** Opens the menu behind `trigger` and picks `option`. */
async function choose(trigger: string | RegExp, option: string) {
  await userEvent.click(screen.getByRole('button', { name: trigger }));
  await userEvent.click(await screen.findByRole('menuitemradio', { name: option }));
}

describe('OverviewSection header', () => {
  beforeEach(() => {
    push.mockReset();
    toastError.mockReset();
    charts.charts = DEFAULT_CHARTS.slice(0, 3);
    charts.setCharts = vi.fn().mockResolvedValue(undefined);
  });

  it('heads the overview with the period, and says what it is compared to', () => {
    renderOverview();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(tc.last12Months);
    expect(screen.getByText(tc.comparedToPreviousMonths.replace('{count}', '12'))).toBeInTheDocument();
    expect(screen.getByRole('region', { name: tc.overview })).toBeInTheDocument();
  });

  it('changes the period from the heading, and the comparison line with it', async () => {
    renderOverview();
    await choose(new RegExp(`^${tc.dateRange}:`), tc.last6Months);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(tc.last6Months);
    expect(screen.getByText(tc.comparedToPreviousMonths.replace('{count}', '6'))).toBeInTheDocument();
  });

  it('compares with the same months last year, or not at all', async () => {
    renderOverview();
    await choose(new RegExp(`^${tc.compare}:`), tc.previousYear);
    expect(screen.getByText(tc.comparedToLastYear)).toBeInTheDocument();
    await choose(new RegExp(`^${tc.compare}:`), tc.compareOff);
    expect(screen.getByText(tc.noComparisonShort)).toBeInTheDocument();
  });

  it('has one Customize button, which opens customize mode with Add chart, Cancel and Save', async () => {
    renderOverview();
    expect(screen.queryByRole('button', { name: tb.addChart })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: tb.customize }));

    expect(screen.getByRole('button', { name: tb.addChart })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: tb.save })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: tb.cancel }));
    expect(screen.getByRole('button', { name: tb.customize })).toBeInTheDocument();
  });

  it('opens the builder straight away when the layout is unchanged', async () => {
    renderOverview();
    await userEvent.click(screen.getByRole('button', { name: tb.customize }));
    await userEvent.click(screen.getByRole('button', { name: tb.addChart }));

    expect(charts.setCharts).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith(CHART_BUILDER_PATH);
  });

  it('saves a changed layout before opening the builder', async () => {
    renderOverview();
    await userEvent.click(screen.getByRole('button', { name: tb.customize }));
    await userEvent.click(screen.getByRole('button', { name: 'remove default-revenue' }));
    await userEvent.click(screen.getByRole('button', { name: tb.addChart }));

    await waitFor(() => expect(push).toHaveBeenCalledWith(CHART_BUILDER_PATH));
    expect(charts.setCharts).toHaveBeenCalledWith(DEFAULT_CHARTS.slice(1, 3));
  });

  it('stays in customize mode when saving the changed layout fails', async () => {
    charts.setCharts = vi.fn().mockRejectedValue(new Error('offline'));
    renderOverview();
    await userEvent.click(screen.getByRole('button', { name: tb.customize }));
    await userEvent.click(screen.getByRole('button', { name: 'remove default-revenue' }));
    await userEvent.click(screen.getByRole('button', { name: tb.addChart }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(tb.saveFailed));
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: tb.save })).toBeInTheDocument();
  });

  it('offers no Customize button while there are no charts', () => {
    charts.charts = [];
    renderOverview();
    expect(screen.queryByRole('button', { name: tb.customize })).not.toBeInTheDocument();
    expect(screen.getByText(tb.emptyTitle)).toBeInTheDocument();
  });
});
