import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CompaniesPage from './page';

const { query, refetch } = vi.hoisted(() => ({
  query: {
    current: {} as Record<string, unknown>,
  },
  refetch: vi.fn(),
}));

vi.mock('@weldsuite/i18n/client', () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock('@/lib/router', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/hooks/queries/use-companies-queries', () => ({
  useInfiniteCompanies: () => query.current,
}));
vi.mock('@/hooks/queries/use-settings-queries', () => ({
  useGridViewSettings: () => ({}),
}));
vi.mock('./components/companies-grid', () => ({
  CompaniesGrid: ({ companies, totalCount }: { companies: unknown[]; totalCount: number }) => (
    <div data-testid="companies-grid">{`${companies.length} of ${totalCount}`}</div>
  ),
}));

const base = {
  data: undefined,
  isPending: false,
  isError: false,
  refetch,
  fetchNextPage: vi.fn(),
  hasNextPage: false,
  isFetchingNextPage: false,
};

beforeEach(() => {
  refetch.mockReset();
  localStorage.clear();
});

describe('CompaniesPage first load', () => {
  it('shows skeleton rows, not the grid or its empty state, while the first request has not completed', () => {
    // After a reload the persisted query cache restores first: the query is
    // pending but idle (isLoading false) and has no data yet.
    query.current = { ...base, isPending: true };
    render(<CompaniesPage />);

    expect(screen.getByTestId('entity-grid-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('companies-grid')).not.toBeInTheDocument();
  });

  it('renders the grid once the request completed, with zero results too', () => {
    query.current = {
      ...base,
      data: { pages: [{ data: [], pagination: { totalCount: 0, hasMore: false, cursor: null } }], pageParams: [undefined] },
    };
    render(<CompaniesPage />);

    expect(screen.queryByTestId('entity-grid-skeleton')).not.toBeInTheDocument();
    expect(screen.getByTestId('companies-grid')).toHaveTextContent('0 of 0');
  });

  it('shows a load error with retry, not the empty state, when the first request failed', () => {
    query.current = { ...base, isError: true };
    render(<CompaniesPage />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByTestId('companies-grid')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'crm.listPage.retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
