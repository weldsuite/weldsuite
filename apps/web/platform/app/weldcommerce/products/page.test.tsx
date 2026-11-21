import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const env = vi.hoisted(() => ({
  search: '',
  replace: vi.fn(),
  fetchNextPage: vi.fn(),
  hasNextPage: true,
  isFetchingNextPage: false,
  filters: [] as unknown[],
}));

vi.mock('@/lib/router', () => ({
  useRouter: () => ({ replace: env.replace }),
  useSearchParams: () => new URLSearchParams(env.search),
}));
vi.mock('@/hooks/use-debounce', () => ({ useDebounce: <T,>(value: T) => value }));
vi.mock('@/hooks/queries/use-weldstash-queries', () => ({
  useInfiniteWeldstashProducts: (filters: unknown) => {
    env.filters.push(filters);
    return {
      data: { pages: [{ data: [{ id: 'prod_1', name: 'Linen shirt' }] }, { data: [{ id: 'prod_2', name: 'Wool coat' }] }] },
      isLoading: false,
      fetchNextPage: env.fetchNextPage,
      hasNextPage: env.hasNextPage,
      isFetchingNextPage: env.isFetchingNextPage,
    };
  },
}));
// The list is tested on its own: show what the page hands it.
vi.mock('./components/products-list', () => ({
  ProductsList: (props: {
    products: { name: string }[];
    search: string;
    hasMore: boolean;
    onSearchChange: (value: string) => void;
    onLoadMore: () => void;
  }) => (
    <div>
      <p>{props.products.map((p) => p.name).join(', ')}</p>
      <p>search:{props.search}</p>
      <p>more:{String(props.hasMore)}</p>
      <button type="button" onClick={() => props.onSearchChange('coat')}>search coat</button>
      <button type="button" onClick={() => props.onSearchChange('')}>clear</button>
      <button type="button" onClick={props.onLoadMore}>load more</button>
    </div>
  ),
}));

import CommerceProductsPage from './page';

beforeEach(() => {
  env.search = '';
  env.replace.mockReset();
  env.fetchNextPage.mockReset();
  env.hasNextPage = true;
  env.isFetchingNextPage = false;
  env.filters = [];
});

describe('WeldCommerce products page', () => {
  it('lists every loaded page of the shared /products rows', () => {
    render(<CommerceProductsPage />);
    expect(screen.getByText('Linen shirt, Wool coat')).toBeInTheDocument();
    expect(screen.getByText('more:true')).toBeInTheDocument();
    expect(env.filters.at(-1)).toEqual({ limit: 50 });
  });

  it('keeps the search and status in the URL and asks for them', async () => {
    env.search = 'search=shirt&status=active';
    render(<CommerceProductsPage />);
    expect(screen.getByText('search:shirt')).toBeInTheDocument();
    expect(env.filters.at(-1)).toEqual({ limit: 50, search: 'shirt', status: 'active' });

    await userEvent.click(screen.getByRole('button', { name: 'search coat' }));
    expect(env.replace).toHaveBeenCalledWith('/weldcommerce/products?search=coat&status=active');
    await userEvent.click(screen.getByRole('button', { name: 'clear' }));
    expect(env.replace).toHaveBeenLastCalledWith('/weldcommerce/products?status=active');
  });

  it('drops the query string when nothing is left in it', async () => {
    env.search = 'search=shirt';
    render(<CommerceProductsPage />);
    await userEvent.click(screen.getByRole('button', { name: 'clear' }));
    expect(env.replace).toHaveBeenCalledWith('/weldcommerce/products');
  });

  it('loads the next page, but not while one is loading', async () => {
    render(<CommerceProductsPage />);
    await userEvent.click(screen.getByRole('button', { name: 'load more' }));
    expect(env.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('does not load more while a page is on its way', async () => {
    env.isFetchingNextPage = true;
    render(<CommerceProductsPage />);
    await userEvent.click(screen.getByRole('button', { name: 'load more' }));
    expect(env.fetchNextPage).not.toHaveBeenCalled();
  });
});
