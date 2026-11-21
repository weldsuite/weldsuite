import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OrderListParams, OrderSummary } from '@/hooks/queries/use-commerce-orders-queries';

const env = vi.hoisted(() => ({
  search: '',
  pages: [] as { data: Partial<OrderSummary>[] }[],
  isLoading: false,
  isError: false,
  hasNextPage: false,
  isFetchingNextPage: false,
  params: [] as OrderListParams[],
  replace: vi.fn(),
  refetch: vi.fn(),
  fetchNextPage: vi.fn(),
}));

vi.mock('@/lib/router', () => ({
  useRouter: () => ({ replace: env.replace }),
  useSearchParams: () => new URLSearchParams(env.search),
}));
vi.mock('@/hooks/use-debounce', () => ({ useDebounce: <T,>(value: T) => value }));
vi.mock('@/hooks/queries/use-commerce-orders-queries', () => ({
  useInfiniteCommerceOrders: (params: OrderListParams) => {
    env.params.push(params);
    return {
      data: { pages: env.pages },
      isLoading: env.isLoading,
      isError: env.isError,
      hasNextPage: env.hasNextPage,
      isFetchingNextPage: env.isFetchingNextPage,
      refetch: env.refetch,
      fetchNextPage: env.fetchNextPage,
    };
  },
}));
vi.mock('./components/orders-list', () => ({
  OrdersList: ({
    orders,
    search,
    filters,
    onSearchChange,
    onFilterChange,
    onClearFilters,
    onLoadMore,
    hasMore,
  }: {
    orders: OrderSummary[];
    search: string;
    filters: Record<string, string>;
    onSearchChange: (value: string) => void;
    onFilterChange: (key: string, value: string | undefined) => void;
    onClearFilters: () => void;
    onLoadMore: () => void;
    hasMore: boolean;
  }) => (
    <div>
      <p data-testid="rows">{orders.map((o) => o.orderNumber).join(',')}</p>
      <p data-testid="search">{search}</p>
      <p data-testid="filters">{JSON.stringify(filters)}</p>
      <button type="button" onClick={() => onSearchChange('acme')}>
        search
      </button>
      <button type="button" onClick={() => onSearchChange('')}>
        clear search
      </button>
      <button type="button" onClick={() => onFilterChange('status', 'pending')}>
        pending
      </button>
      <button type="button" onClick={() => onFilterChange('status', undefined)}>
        any status
      </button>
      <button type="button" onClick={onClearFilters}>
        clear filters
      </button>
      {hasMore && (
        <button type="button" onClick={onLoadMore}>
          more
        </button>
      )}
    </div>
  ),
}));

import CommerceOrdersPage from './page';

beforeEach(() => {
  env.search = '';
  env.pages = [{ data: [{ id: 'o1', orderNumber: 'WC-1' }, { id: 'o2', orderNumber: 'WC-2' }] }];
  env.isLoading = false;
  env.isError = false;
  env.hasNextPage = false;
  env.isFetchingNextPage = false;
  env.params = [];
  env.replace.mockReset();
  env.refetch.mockReset();
  env.fetchNextPage.mockReset();
});

describe('CommerceOrdersPage', () => {
  it('lists the orders of every page', () => {
    env.pages = [{ data: [{ id: 'o1', orderNumber: 'WC-1' }] }, { data: [{ id: 'o2', orderNumber: 'WC-2' }] }];
    render(<CommerceOrdersPage />);
    expect(screen.getByTestId('rows').textContent).toBe('WC-1,WC-2');
  });

  it('asks the API for the search and every filter in the URL', () => {
    env.search = 'search=acme&status=pending&paymentStatus=paid&approvalStatus=pending&source=manual&from=2026-11-01&to=2026-11-30&unrelated=1';
    render(<CommerceOrdersPage />);
    expect(env.params.at(-1)).toEqual({
      limit: 50,
      search: 'acme',
      status: 'pending',
      paymentStatus: 'paid',
      approvalStatus: 'pending',
      source: 'manual',
      from: '2026-11-01',
      to: '2026-11-30',
    });
    expect(screen.getByTestId('filters').textContent).not.toContain('unrelated');
  });

  it('keeps the search and the filters in the URL', async () => {
    env.search = 'status=confirmed&open=ord_1';
    const user = userEvent.setup();
    render(<CommerceOrdersPage />);
    await user.click(screen.getByRole('button', { name: 'search' }));
    expect(env.replace).toHaveBeenLastCalledWith('/weldcommerce/orders?status=confirmed&open=ord_1&search=acme');
    await user.click(screen.getByRole('button', { name: 'pending' }));
    expect(env.replace).toHaveBeenLastCalledWith('/weldcommerce/orders?status=pending&open=ord_1');
    await user.click(screen.getByRole('button', { name: 'any status' }));
    expect(env.replace).toHaveBeenLastCalledWith('/weldcommerce/orders?open=ord_1');
  });

  it('clears the filters but leaves the search and the open panel', async () => {
    env.search = 'search=acme&status=confirmed&from=2026-11-01&open=ord_1';
    const user = userEvent.setup();
    render(<CommerceOrdersPage />);
    await user.click(screen.getByRole('button', { name: 'clear filters' }));
    expect(env.replace).toHaveBeenLastCalledWith('/weldcommerce/orders?search=acme&open=ord_1');
  });

  it('removes the search from the URL when it is emptied', async () => {
    env.search = 'search=acme';
    const user = userEvent.setup();
    render(<CommerceOrdersPage />);
    await user.click(screen.getByRole('button', { name: 'clear search' }));
    expect(env.replace).toHaveBeenLastCalledWith('/weldcommerce/orders');
  });

  it('loads the next page once, and not while one is loading', async () => {
    env.hasNextPage = true;
    const user = userEvent.setup();
    const { rerender } = render(<CommerceOrdersPage />);
    await user.click(screen.getByRole('button', { name: 'more' }));
    expect(env.fetchNextPage).toHaveBeenCalledTimes(1);
    env.isFetchingNextPage = true;
    rerender(<CommerceOrdersPage />);
    await user.click(screen.getByRole('button', { name: 'more' }));
    expect(env.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('shows an error with a retry when the first load fails', async () => {
    env.isError = true;
    env.pages = [];
    const user = userEvent.setup();
    render(<CommerceOrdersPage />);
    expect(screen.getByText('Could not load the orders.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /retry|try again/i }));
    expect(env.refetch).toHaveBeenCalled();
  });
});
