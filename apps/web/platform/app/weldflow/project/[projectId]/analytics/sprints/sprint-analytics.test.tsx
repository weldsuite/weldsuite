import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { Sprint } from '@weldsuite/app-api-client/schemas/flow-agile';

type Query<T> = { isLoading: boolean; isError: boolean; data: T | undefined; refetch: () => void };

const state = vi.hoisted(() => ({
  pathname: '/weldflow/project/p1/analytics/sprints',
  delivery: { usesSprints: true, isLoading: false },
  sprints: { isLoading: false, isError: false, data: [], refetch: vi.fn() } as Query<unknown>,
  report: { isLoading: false, isError: false, data: undefined, refetch: vi.fn() } as Query<unknown>,
  breadcrumbs: vi.fn(),
}));

vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: (segments: unknown) => state.breadcrumbs(segments) }));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useParams: () => ({ projectId: 'p1' }),
  usePathname: () => state.pathname,
}));
vi.mock('@/hooks/queries/use-flow-agile-queries', () => ({
  useProjectDelivery: () => state.delivery,
  useProjectSprints: () => state.sprints,
  useSprintReport: () => state.report,
}));
vi.mock('@/components/weldflow/agile/burndown-chart', () => ({
  BurndownChart: ({ points, label }: { points: unknown[]; label: string }) => (
    <div data-testid="burndown">
      {label}: {points.length}
    </div>
  ),
}));
vi.mock('@/components/weldflow/agile/velocity-chart', () => ({
  VelocityChart: ({ bars, average }: { bars: { name: string }[]; average: number | null }) => (
    <div data-testid="velocity">
      {bars.map((bar) => bar.name).join(',')} avg {String(average)}
    </div>
  ),
}));

import SprintAnalyticsPage from './page';
import { AnalyticsViewSwitch } from '../_components/analytics-view-switch';

const wrap = (node: ReactNode) => <I18nProvider initialLanguage="en">{node}</I18nProvider>;

function sprint(id: string, status: string, extra: Partial<Sprint> = {}): Sprint {
  return {
    id,
    projectId: 'p1',
    name: `Sprint ${id}`,
    goal: null,
    status,
    startDate: '2026-10-01',
    endDate: '2026-10-14',
    startedAt: null,
    completedAt: null,
    velocity: null,
    storyPointsCommitted: null,
    storyPointsCompleted: null,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    ...extra,
  };
}

const query = <T,>(data: T | undefined, extra: Partial<Query<T>> = {}): Query<T> => ({
  isLoading: false,
  isError: false,
  data,
  refetch: vi.fn(),
  ...extra,
});

const completedSprints = [
  sprint('1', 'completed', {
    completedAt: '2026-10-14T10:00:00Z',
    goal: 'Ship it',
    report: { committed: { points: 10, count: 4, taskIds: [] }, completed: { points: 8, count: 3 }, added: { points: 2, count: 1 }, goalMet: true, carriedOver: { points: 2, count: 1, taskIds: [], toSprintId: null, toBacklog: 0 } },
  }),
  sprint('2', 'completed', {
    startDate: '2026-10-15',
    endDate: '2026-10-28',
    completedAt: '2026-10-28T10:00:00Z',
    storyPointsCommitted: 12,
    storyPointsCompleted: 6,
    velocity: 6,
    report: { goalMet: false },
  }),
  sprint('3', 'completed', { startDate: '2026-10-29', endDate: '2026-11-11', completedAt: '2026-11-11T10:00:00Z', storyPointsCommitted: 5, storyPointsCompleted: 5 }),
];

beforeEach(() => {
  state.pathname = '/weldflow/project/p1/analytics/sprints';
  state.delivery = { usesSprints: true, isLoading: false };
  state.sprints = query([]);
  state.report = query(undefined);
  state.breadcrumbs.mockReset();
});

describe('SprintAnalyticsPage', () => {
  it('sets the breadcrumbs', () => {
    render(wrap(<SprintAnalyticsPage />));
    const segments = state.breadcrumbs.mock.calls[0]![0] as { label: string; href?: string }[];
    expect(segments.map((segment) => segment.label)).toEqual(['Projects', 'Project Analytics', 'Sprints']);
  });

  it('shows a loader while the delivery setting or the sprints load', () => {
    state.sprints = query(undefined, { isLoading: true });
    render(wrap(<SprintAnalyticsPage />));
    expect(screen.queryByText('Velocity')).not.toBeInTheDocument();
  });

  it('says sprints are not available for a project without them, and has no view switch', () => {
    state.delivery = { usesSprints: false, isLoading: false };
    render(wrap(<SprintAnalyticsPage />));
    expect(screen.getByText('Sprints aren’t available on this edition.')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Analytics views' })).not.toBeInTheDocument();
  });

  it('offers a retry when the sprints fail to load', async () => {
    const user = userEvent.setup();
    const failed = query(undefined, { isError: true });
    state.sprints = failed;
    render(wrap(<SprintAnalyticsPage />));
    expect(screen.getByRole('alert')).toHaveTextContent('The sprint reports couldn’t be loaded.');
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(failed.refetch).toHaveBeenCalled();
  });

  it('shows dashes and empty states before a sprint was completed', () => {
    render(wrap(<SprintAnalyticsPage />));
    expect(screen.getAllByText('–')).toHaveLength(4);
    expect(screen.getByText('No sprint is running. Start a sprint to see its burndown.')).toBeInTheDocument();
    expect(screen.getByText('Velocity appears after the first sprint is completed.')).toBeInTheDocument();
    expect(screen.getByText('No completed sprints yet')).toBeInTheDocument();
  });

  it('shows the KPIs, the velocity chart and the history of completed sprints', () => {
    state.sprints = query([...completedSprints].reverse());
    render(wrap(<SprintAnalyticsPage />));

    // (8 + 6 + 5) / 3 sprints; the last sprint made 5.
    expect(screen.getByText('6 points')).toBeInTheDocument();
    expect(screen.getByText('5 points')).toBeInTheDocument();
    expect(screen.getByText('70%')).toBeInTheDocument();
    expect(screen.getByTestId('velocity')).toHaveTextContent('Sprint 1,Sprint 2,Sprint 3');

    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('row');
    // Header and the three sprints, the latest completed first.
    expect(rows).toHaveLength(4);
    expect(within(rows[1]!).getByRole('link', { name: 'Sprint 3' })).toHaveAttribute('href', '/weldflow/project/p1/sprints/3/report');
    // Sprint 1 has a goal, a frozen report with added scope and a met goal.
    const first = within(rows[3]!);
    expect(first.getByText('Ship it')).toBeInTheDocument();
    expect(first.getByText('+2')).toBeInTheDocument();
    expect(first.getByText('Yes')).toBeInTheDocument();
    // Sprint 2 missed the goal; sprint 3 has none recorded.
    expect(within(rows[2]!).getByText('No')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('–')).toBeInTheDocument();
  });

  it('shows the burndown of the running sprint', () => {
    state.sprints = query([sprint('A', 'active', { name: 'Sprint A' }), ...completedSprints]);
    state.report = query({ burndown: [{ date: '2026-11-02', remaining: 10, ideal: 10 }] });
    render(wrap(<SprintAnalyticsPage />));
    expect(screen.getByTestId('burndown')).toHaveTextContent('Sprint A · story points remaining: 1');
  });

  it('shows a loader and an error for the running sprint’s burndown', async () => {
    const user = userEvent.setup();
    state.sprints = query([sprint('A', 'active')]);
    state.report = query(undefined, { isLoading: true });
    const { unmount } = render(wrap(<SprintAnalyticsPage />));
    expect(screen.queryByTestId('burndown')).not.toBeInTheDocument();
    unmount();

    const failed = query(undefined, { isError: true });
    state.report = failed;
    render(wrap(<SprintAnalyticsPage />));
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(failed.refetch).toHaveBeenCalled();
  });
});

describe('AnalyticsViewSwitch', () => {
  it('switches between Sprints and Custom reports, marking the current one', () => {
    render(wrap(<AnalyticsViewSwitch projectId="p1" />));
    const nav = screen.getByRole('navigation', { name: 'Analytics views' });
    const sprints = within(nav).getByRole('link', { name: 'Sprints' });
    expect(sprints).toHaveAttribute('href', '/weldflow/project/p1/analytics/sprints');
    expect(sprints).toHaveAttribute('aria-current', 'page');
    const custom = within(nav).getByRole('link', { name: 'Custom reports' });
    expect(custom).toHaveAttribute('href', '/weldflow/project/p1/analytics');
    expect(custom).not.toHaveAttribute('aria-current');
  });

  it('marks Custom reports on the analytics root', () => {
    state.pathname = '/weldflow/project/p1/analytics';
    render(wrap(<AnalyticsViewSwitch projectId="p1" />));
    expect(screen.getByRole('link', { name: 'Custom reports' })).toHaveAttribute('aria-current', 'page');
  });

  it('is not shown for a project that does not plan in sprints', () => {
    state.delivery = { usesSprints: false, isLoading: false };
    const { container } = render(wrap(<AnalyticsViewSwitch projectId="p1" />));
    expect(container).toBeEmptyDOMElement();
  });
});
