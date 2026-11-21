/**
 * The phone report: KPIs with the change against the previous period, the
 * tables, and the empty state that points at the phone settings.
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { DeskPhoneReport } from '@weldsuite/core-api-client/schemas/helpdesk-live-reports';

const state = vi.hoisted(() => ({
  query: {} as { data: unknown; isLoading: boolean; isError: boolean; refetch: () => Promise<unknown> },
  ranges: [] as string[],
  push: (() => undefined) as (href: string) => void,
}));

vi.mock('@/hooks/queries/use-desk-reports-queries', () => ({
  DESK_OVERVIEW_RANGES: ['last_7_days', 'last_30_days'],
  useDeskPhoneReport: (range: string) => {
    state.ranges.push(range);
    return state.query;
  },
}));

vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: (href: string) => state.push(href) }),
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: english, language: 'en' }) };
});

vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => undefined }));

// Charts need a real layout; the numbers and tables are what is under test.
vi.mock('@weldsuite/ui/components/chart', () => ({
  ChartContainer: (_props: { children: ReactNode }) => <div data-testid="chart" />,
  ChartLegend: () => null,
  ChartLegendContent: () => null,
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
}));
vi.mock('recharts', () => ({
  Bar: () => null,
  BarChart: () => null,
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

// The Radix select needs a real layout; the period picker is not under test.
vi.mock('@weldsuite/ui/components/select', () => ({
  Select: ({ value, children }: { value: string; children: ReactNode }) => <div data-value={value}>{children}</div>,
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: () => null,
  SelectItem: () => null,
}));

import DeskPhoneReportPage from './page';

const pair = <T,>(value: T, previous: T) => ({ value, previous });

function report(overrides: Partial<DeskPhoneReport> = {}): DeskPhoneReport {
  return {
    range: 'last_30_days',
    start: '2026-10-10',
    end: '2026-11-09',
    bucket: 'day',
    kpis: {
      offered: pair(120, 100),
      answered: pair(96, 80),
      missed: pair(14, 10),
      abandoned: pair(10, 10),
      voicemail: pair(4, 0),
      answerRate: pair<number | null>(80, 80),
      waitAvg: pair<number | null>(45, 60),
      waitMedian: pair<number | null>(30, 30),
      abandonAvg: pair<number | null>(20, null),
      handleAvg: pair<number | null>(300, 240),
      handleMedian: pair<number | null>(280, 240),
      longestWait: pair<number | null>(725, 600),
    },
    series: [
      { date: '2026-11-07', offered: 10, answered: 8, missed: 1, abandoned: 1 },
      { date: '2026-11-08', offered: 12, answered: 9, missed: 2, abandoned: 1 },
    ],
    agents: [{ id: 'u1', name: 'Sam Support', answered: 50, handleAvg: 310, handleTotal: 15500 }],
    teams: [
      { id: null, name: null, offered: 70, answered: 55, missed: 8, abandoned: 7, waitAvg: 50 },
      { id: 'dept_a', name: 'Billing', offered: 50, answered: 41, missed: 6, abandoned: 3, waitAvg: 35 },
    ],
    hours: Array.from({ length: 24 }, (_, hour) => ({ hour, offered: hour === 9 ? 20 : 0, answered: hour === 9 ? 18 : 0 })),
    ...overrides,
  };
}

beforeEach(() => {
  state.ranges = [];
  state.push = () => undefined;
  state.query = { data: report(), isLoading: false, isError: false, refetch: () => Promise.resolve() };
});

afterEach(cleanup);

describe('DeskPhoneReportPage', () => {
  it('renders the KPIs with the change against the previous period', () => {
    render(<DeskPhoneReportPage />);

    for (const label of [
      'Calls offered',
      'Answered',
      'Missed',
      'Abandoned',
      'Voicemail',
      'Wait time (average)',
      'Wait time (median)',
      'Time to abandon (average)',
      'Handle time (average)',
      'Handle time (median)',
      'Longest wait',
    ]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByText('120')).toBeTruthy();
    expect(screen.getByText('80% answer rate')).toBeTruthy();
    expect(screen.getByText('12m')).toBeTruthy();
    // Offered 100 -> 120 is +20%; missed 10 -> 14 is +40% and bad; average wait 60 -> 45 is -25% and good.
    expect(screen.getByText('40%').className).toContain('text-destructive');
    expect(screen.getAllByText('25%').some((node) => node.className.includes('text-emerald-600'))).toBe(true);
    expect(screen.getAllByText('20%').length).toBeGreaterThan(0);
    expect(screen.getAllByText('vs. previous period').length).toBeGreaterThanOrEqual(5);
  });

  it('labels the bucket and says the hours are UTC', () => {
    render(<DeskPhoneReportPage />);
    expect(screen.getByText('Per day')).toBeTruthy();
    expect(screen.getByText('Hours are UTC.')).toBeTruthy();
  });

  it('lists agents and teams, naming the general queue', () => {
    render(<DeskPhoneReportPage />);
    expect(screen.getByText('Sam Support')).toBeTruthy();
    expect(screen.getByText('General queue')).toBeTruthy();
    expect(screen.getByText('Billing')).toBeTruthy();
  });

  it('explains how calls get here when there were none, with a link to the phone settings', () => {
    state.query = {
      data: report({ kpis: { ...report().kpis, offered: pair(0, 0) }, series: [], agents: [], teams: [] }),
      isLoading: false,
      isError: false,
      refetch: () => Promise.resolve(),
    };
    const push = vi.fn();
    state.push = push;
    render(<DeskPhoneReportPage />);

    expect(screen.getByText('No calls in this period')).toBeTruthy();
    expect(screen.getByText(/once a phone number is set to ring your agents/)).toBeTruthy();
    expect(screen.queryByText('Calls offered')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Set up a phone number' }));
    expect(push).toHaveBeenCalledWith('/settings/apps/welddesk/phone');
  });

  it('shows an error when the report fails', () => {
    state.query = { data: undefined, isLoading: false, isError: true, refetch: () => Promise.resolve() };
    render(<DeskPhoneReportPage />);
    expect(screen.getByText('Failed to load the phone report')).toBeTruthy();
  });

  it('starts on the last 30 days like the overview', () => {
    render(<DeskPhoneReportPage />);
    expect(state.ranges.at(-1)).toBe('last_30_days');
  });
});
