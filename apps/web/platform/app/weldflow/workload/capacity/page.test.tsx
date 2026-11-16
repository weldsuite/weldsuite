import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Provider } from 'jotai';
import { en } from '@weldsuite/i18n/locales/en';
import { interpolate } from '@weldsuite/i18n/provider';
import type { CapacityResponse } from '@weldsuite/app-api-client/domains/flow-portfolio';

const STORAGE_KEY = 'weldflow.capacity.showRequests';

const queries = vi.hoisted(() => ({
  capacity: { data: undefined as unknown, isError: false, refetch: vi.fn(() => Promise.resolve()) },
  calls: [] as Array<Record<string, unknown>>,
  permissions: new Set<string>(),
}));

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({ language: 'en', t: en, format: interpolate }),
}));

vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => queries.permissions.has(permission) }),
}));

vi.mock('@/hooks/queries/use-flow-portfolio-queries', () => ({
  useCapacity: (params: Record<string, unknown>) => {
    queries.calls.push(params);
    return queries.capacity;
  },
  useResourceRequests: () => ({ data: [], isLoading: false }),
  useMemberNames: () => ({ nameOf: (id: string) => (id === 'u_ann' ? 'Ann' : id), pictureOf: () => undefined, options: [] }),
}));

// The shell, the dialogs and the requests' own queries have their own tests.
vi.mock('../workload-shell', () => ({
  WorkloadShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  WorkloadViewSwitch: () => null,
}));
vi.mock('./_components/dialogs', () => ({ RequestDialog: () => null, ProfileDialog: () => null }));
vi.mock('./_components/requests-panel', () => ({ RequestsPanel: () => <aside data-testid="requests-panel" /> }));

import CapacityPage from './page';

const load: CapacityResponse = {
  from: '2026-11-16',
  to: '2026-11-22',
  tentative: true,
  weeks: [{ week: '2026-W47', startsOn: '2026-11-16', endsOn: '2026-11-22' }],
  totals: [{ bookedHours: 20, capacityHours: 40 }],
  members: [
    {
      memberId: 'u_ann',
      weeklyHours: 40,
      skills: ['Backend'],
      hasProfile: true,
      cells: [{ hours: 20, tentativeHours: 0, percent: 50, band: 'ok' }],
      projects: [],
    },
  ],
  summary: { memberCount: 1, bookedHours: 20, capacityHours: 40, percent: 50, overbookedPersonWeeks: 0 },
};

function renderPage() {
  return render(
    <Provider>
      <CapacityPage />
    </Provider>,
  );
}

const requestsToggle = () => screen.getByRole('button', { name: 'Resource requests' });

beforeEach(() => {
  queries.capacity = { data: load, isError: false, refetch: vi.fn(() => Promise.resolve()) };
  queries.calls = [];
  queries.permissions = new Set(['portfolio:manage']);
});

afterEach(() => {
  localStorage.clear();
});

describe('CapacityPage', () => {
  it('shows the heatmap with the resource requests beside it', () => {
    renderPage();
    expect(screen.getByRole('region', { name: 'Booked per week' })).toBeInTheDocument();
    expect(screen.getByTestId('requests-panel')).toBeInTheDocument();
    expect(requestsToggle()).toHaveAttribute('aria-pressed', 'true');
  });

  it('hides and shows the resource requests from the toolbar, remembering the choice', async () => {
    renderPage();
    await userEvent.click(requestsToggle());
    expect(screen.queryByTestId('requests-panel')).not.toBeInTheDocument();
    expect(requestsToggle()).toHaveAttribute('aria-pressed', 'false');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('false');

    await userEvent.click(requestsToggle());
    expect(screen.getByTestId('requests-panel')).toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true');
  });

  it('keeps the resource requests hidden on a later visit', async () => {
    localStorage.setItem(STORAGE_KEY, 'false');
    renderPage();
    expect(await screen.findByRole('button', { name: 'Resource requests', pressed: false })).toBeInTheDocument();
    expect(screen.queryByTestId('requests-panel')).not.toBeInTheDocument();
  });

  it('offers to request a person only to those who may book', () => {
    const { unmount } = renderPage();
    expect(screen.getByRole('button', { name: 'Request a person' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit profile of Ann' })).toBeInTheDocument();
    unmount();

    queries.permissions = new Set();
    renderPage();
    expect(screen.queryByRole('button', { name: 'Request a person' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit profile of/ })).not.toBeInTheDocument();
  });

  it('filters by skill and shows the load as people or skill groups', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'Backend' }));
    expect(queries.calls.at(-1)).toMatchObject({ skill: 'Backend' });

    await userEvent.click(screen.getByRole('button', { name: 'Skill' }));
    expect(screen.getByText('Skill group')).toBeInTheDocument();
  });

  it('offers a retry when the load fails', async () => {
    queries.capacity = { data: undefined, isError: true, refetch: vi.fn(() => Promise.resolve()) };
    renderPage();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: en.flowPortfolio.common.retry }));
    expect(queries.capacity.refetch).toHaveBeenCalled();
  });
});
