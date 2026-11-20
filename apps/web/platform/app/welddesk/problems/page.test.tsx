/**
 * The problems list: rows with status, owner, team and open / total tickets,
 * the tabs and the search going into the query, empty and failed states, the
 * "New problem" button only for those who may create, and opening a row.
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { DeskProblem, DeskProblemFilters } from '@/hooks/queries/use-desk-problem-queries';

const state = vi.hoisted(() => ({
  query: {} as Record<string, unknown>,
  filters: [] as DeskProblemFilters[],
  perms: new Set<string>(),
  push: vi.fn<(href: string) => void>(),
}));

vi.mock('@/lib/i18n', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { getTranslations: (ns: keyof typeof english) => english[ns] };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: (key: string) => state.perms.has(key) }));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
  useRouter: () => ({ push: state.push }),
  useParams: () => ({}),
}));
vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => undefined }));
vi.mock('@/lib/api/use-app-api', () => ({ useAppApiClient: () => ({ getClient: vi.fn() }), useAppApi: () => ({}) }));
vi.mock('@/hooks/queries/use-desk-workspace-members', () => ({
  useDeskWorkspaceMembers: () => ({ data: [{ userId: 'user_ada', name: 'Ada Lovelace' }] }),
}));
vi.mock('@/hooks/queries/use-desk-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/queries/use-desk-queries')>()),
  useDeskAttributeOptions: () => ({ data: { teams: [{ id: 'dept_pay', name: 'Payments' }] } }),
}));
vi.mock('@/hooks/queries/use-desk-problem-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/queries/use-desk-problem-queries')>()),
  useDeskProblems: (filters: DeskProblemFilters) => {
    state.filters.push(filters);
    return state.query;
  },
  useCreateDeskProblem: () => ({ mutate: vi.fn(), isPending: false }),
}));

import DeskProblemsPage from './page';

function problem(overrides: Partial<DeskProblem>): DeskProblem {
  return {
    id: 'dprob_1',
    createdAt: '2026-01-01T10:00:00.000Z',
    updatedAt: '2026-01-02T10:00:00.000Z',
    problemNumber: 1,
    title: 'Checkout fails',
    description: null,
    status: 'known_error',
    priority: 'high',
    rootCause: null,
    workaround: 'Use PayPal',
    resolution: null,
    assigneeId: 'user_ada',
    departmentId: 'dept_pay',
    articleId: null,
    knownErrorAt: '2026-01-02T10:00:00.000Z',
    resolvedAt: null,
    closedAt: null,
    createdById: null,
    incidentCount: 3,
    openIncidentCount: 1,
    ...overrides,
  };
}

const found = (...rows: DeskProblem[]) => ({
  data: { pages: [{ data: rows, pagination: { totalCount: rows.length, hasMore: false, cursor: null } }] },
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
  hasNextPage: false,
  fetchNextPage: vi.fn(),
  isFetchingNextPage: false,
});

beforeEach(() => {
  state.filters = [];
  state.perms = new Set(['problems:read', 'problems:create']);
  state.push.mockReset();
  state.query = found(
    problem({}),
    problem({ id: 'dprob_2', problemNumber: 2, title: 'Slow search', status: 'investigating', priority: null, assigneeId: null, departmentId: null, incidentCount: 0, openIncidentCount: 0 }),
  );
});
afterEach(cleanup);

describe('DeskProblemsPage', () => {
  it('lists each problem with its status, owner, team and open / total tickets', () => {
    render(<DeskProblemsPage />);
    const rows = screen.getAllByText(/Checkout fails|Slow search/);
    expect(rows).toHaveLength(2);
    expect(screen.getByText('#1')).toBeTruthy();
    expect(screen.getByText('Known error')).toBeTruthy();
    expect(screen.getByText('Investigating')).toBeTruthy();
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    expect(screen.getByText('Payments')).toBeTruthy();
    expect(screen.getByText('Nobody')).toBeTruthy();
    expect(screen.getAllByTestId('desk-problem-incidents').map((cell) => cell.textContent)).toEqual(['1 / 3', '0 / 0']);
  });

  it('starts on the open tab and sends the tab and the search into the query', () => {
    render(<DeskProblemsPage />);
    expect(state.filters.at(-1)).toEqual({ view: 'open', q: '' });

    fireEvent.click(screen.getByRole('tab', { name: 'Known errors' }));
    expect(state.filters.at(-1)).toMatchObject({ view: 'known_errors' });

    fireEvent.change(screen.getByPlaceholderText('Search problems or #number'), { target: { value: ' paypal ' } });
    expect(state.filters.at(-1)).toEqual({ view: 'known_errors', q: 'paypal' });
  });

  it('opens a problem from its row', () => {
    render(<DeskProblemsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Open problem #2' }));
    expect(state.push).toHaveBeenCalledWith('/welddesk/problems/dprob_2');
  });

  it('says so when there is nothing, with a different line on the known-errors tab', () => {
    state.query = found();
    render(<DeskProblemsPage />);
    expect(screen.getByText('No problems here yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Known errors' }));
    expect(screen.getByText('No known errors yet')).toBeTruthy();
  });

  it('shows a failed load with a retry', () => {
    const refetch = vi.fn();
    state.query = { data: undefined, isLoading: false, isError: true, refetch };
    render(<DeskProblemsPage />);
    expect(screen.getByText('The problems could not be loaded.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('offers "New problem" only to those who may create', () => {
    const { unmount } = render(<DeskProblemsPage />);
    expect(screen.getByTestId('desk-problem-new')).toBeTruthy();
    unmount();
    state.perms = new Set(['problems:read']);
    render(<DeskProblemsPage />);
    expect(screen.queryByTestId('desk-problem-new')).toBeNull();
  });
});
