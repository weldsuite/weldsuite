import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CommerceDiscount, DiscountListParams } from '@/hooks/queries/use-commerce-orders-queries';

const env = vi.hoisted(() => ({
  search: '',
  pages: [] as { data: Partial<CommerceDiscount>[] }[],
  isError: false,
  hasNextPage: false,
  params: [] as DiscountListParams[],
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
  useInfiniteCommerceDiscounts: (params: DiscountListParams) => {
    env.params.push(params);
    return {
      data: { pages: env.pages },
      isLoading: false,
      isError: env.isError,
      hasNextPage: env.hasNextPage,
      isFetchingNextPage: false,
      refetch: env.refetch,
      fetchNextPage: env.fetchNextPage,
    };
  },
}));
vi.mock('./components/discounts-list', () => ({
  DiscountsList: ({
    discounts,
    effectiveStatus,
    onSearchChange,
    onEffectiveStatusChange,
    onLoadMore,
  }: {
    discounts: CommerceDiscount[];
    effectiveStatus?: string;
    onSearchChange: (value: string) => void;
    onEffectiveStatusChange: (value: string | undefined) => void;
    onLoadMore: () => void;
  }) => (
    <div>
      <p data-testid="rows">{discounts.map((d) => d.code).join(',')}</p>
      <p data-testid="status">{effectiveStatus ?? 'all'}</p>
      <button type="button" onClick={() => onSearchChange('spring')}>
        search
      </button>
      <button type="button" onClick={() => onEffectiveStatusChange('expired')}>
        expired
      </button>
      <button type="button" onClick={() => onEffectiveStatusChange(undefined)}>
        all
      </button>
      <button type="button" onClick={onLoadMore}>
        more
      </button>
    </div>
  ),
}));

import CommerceDiscountsPage from './page';

beforeEach(() => {
  env.search = '';
  env.pages = [{ data: [{ id: 'd1', code: 'SPRING' }, { id: 'd2', code: 'WINTER' }] }];
  env.isError = false;
  env.hasNextPage = false;
  env.params = [];
  env.replace.mockReset();
  env.refetch.mockReset();
  env.fetchNextPage.mockReset();
});

describe('CommerceDiscountsPage', () => {
  it('lists the discounts', () => {
    render(<CommerceDiscountsPage />);
    expect(screen.getByTestId('rows').textContent).toBe('SPRING,WINTER');
  });

  it('asks the API for the search and the status in the URL', () => {
    env.search = 'search=spring&effectiveStatus=active';
    render(<CommerceDiscountsPage />);
    expect(env.params.at(-1)).toEqual({ limit: 50, search: 'spring', effectiveStatus: 'active' });
    expect(screen.getByTestId('status').textContent).toBe('active');
  });

  it('keeps the search and the status in the URL', async () => {
    env.search = 'open=dsc_1';
    const user = userEvent.setup();
    render(<CommerceDiscountsPage />);
    await user.click(screen.getByRole('button', { name: 'search' }));
    expect(env.replace).toHaveBeenLastCalledWith('/weldcommerce/discounts?open=dsc_1&search=spring');
    await user.click(screen.getByRole('button', { name: 'expired' }));
    expect(env.replace).toHaveBeenLastCalledWith('/weldcommerce/discounts?open=dsc_1&effectiveStatus=expired');
    await user.click(screen.getByRole('button', { name: 'all' }));
    expect(env.replace).toHaveBeenLastCalledWith('/weldcommerce/discounts?open=dsc_1');
  });

  it('loads the next page only when there is one', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<CommerceDiscountsPage />);
    await user.click(screen.getByRole('button', { name: 'more' }));
    expect(env.fetchNextPage).not.toHaveBeenCalled();
    unmount();
    env.hasNextPage = true;
    render(<CommerceDiscountsPage />);
    await user.click(screen.getByRole('button', { name: 'more' }));
    expect(env.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('shows an error with a retry when the first load fails', async () => {
    env.isError = true;
    env.pages = [];
    const user = userEvent.setup();
    render(<CommerceDiscountsPage />);
    expect(screen.getByText('Could not load the discounts.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /retry|try again/i }));
    expect(env.refetch).toHaveBeenCalled();
  });
});
