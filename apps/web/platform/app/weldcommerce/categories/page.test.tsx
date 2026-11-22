import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CommerceCategoryNode } from '@/hooks/queries/use-commerce-queries';

const env = vi.hoisted(() => ({
  search: '',
  replace: vi.fn(),
  fetchNextPage: vi.fn(),
  hasNextPage: true,
  isFetchingNextPage: false,
  searchEnabled: [] as boolean[],
}));

vi.mock('@/lib/router', () => ({
  useRouter: () => ({ replace: env.replace }),
  useSearchParams: () => new URLSearchParams(env.search),
}));
vi.mock('@/hooks/use-debounce', () => ({ useDebounce: <T,>(value: T) => value }));

function node(id: string, depth: number, children: CommerceCategoryNode[] = []): CommerceCategoryNode {
  return {
    id,
    name: id,
    slug: id,
    description: null,
    parentId: null,
    path: null,
    depth,
    type: 'manual',
    rules: null,
    rulesMatch: null,
    isActive: true,
    sortOrder: null,
    publishedAt: null,
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
    children,
  };
}

vi.mock('@/hooks/queries/use-commerce-queries', () => ({
  useCommerceCategoryTree: () => ({
    data: { data: [node('Clothing', 0, [node('Shirts', 1)]), node('Shoes', 0)] },
    isLoading: false,
  }),
  useInfiniteCommerceCategories: (_params: unknown, enabled: boolean) => {
    env.searchEnabled.push(enabled);
    return {
      data: { pages: [{ data: [node('Linen shirts', 2)] }] },
      isLoading: false,
      hasNextPage: env.hasNextPage,
      isFetchingNextPage: env.isFetchingNextPage,
      fetchNextPage: env.fetchNextPage,
    };
  },
}));
vi.mock('./components/categories-list', () => ({
  CategoriesList: (props: {
    categories: { name: string }[];
    showHierarchy: boolean;
    hasMore: boolean;
    onSearchChange: (value: string) => void;
    onLoadMore?: () => void;
  }) => (
    <div>
      <p>{props.categories.map((c) => c.name).join(', ')}</p>
      <p>hierarchy:{String(props.showHierarchy)}</p>
      <p>more:{String(props.hasMore)}</p>
      <button type="button" onClick={() => props.onSearchChange('shirt')}>search</button>
      <button type="button" onClick={() => props.onSearchChange('')}>clear</button>
      {props.onLoadMore && (
        <button type="button" onClick={props.onLoadMore}>
          load more
        </button>
      )}
    </div>
  ),
}));

import CommerceCategoriesPage from './page';

beforeEach(() => {
  env.search = '';
  env.replace.mockReset();
  env.fetchNextPage.mockReset();
  env.hasNextPage = true;
  env.isFetchingNextPage = false;
  env.searchEnabled = [];
});

describe('WeldCommerce categories page', () => {
  it('shows the tree, parents above their children, and does not search', () => {
    render(<CommerceCategoriesPage />);
    expect(screen.getByText('Clothing, Shirts, Shoes')).toBeInTheDocument();
    expect(screen.getByText('hierarchy:true')).toBeInTheDocument();
    expect(screen.getByText('more:false')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'load more' })).not.toBeInTheDocument();
    expect(env.searchEnabled.every((enabled) => !enabled)).toBe(true);
  });

  it('shows the flat search results while searching, and pages them', async () => {
    env.search = 'search=linen';
    render(<CommerceCategoriesPage />);
    expect(screen.getByText('Linen shirts')).toBeInTheDocument();
    expect(screen.getByText('hierarchy:false')).toBeInTheDocument();
    expect(screen.getByText('more:true')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'load more' }));
    expect(env.fetchNextPage).toHaveBeenCalled();
  });

  it('does not ask for a page while one is loading', async () => {
    env.search = 'search=linen';
    env.isFetchingNextPage = true;
    render(<CommerceCategoriesPage />);
    await userEvent.click(screen.getByRole('button', { name: 'load more' }));
    expect(env.fetchNextPage).not.toHaveBeenCalled();
  });

  it('keeps the search in the URL', async () => {
    render(<CommerceCategoriesPage />);
    await userEvent.click(screen.getByRole('button', { name: 'search' }));
    expect(env.replace).toHaveBeenCalledWith('/weldcommerce/categories?search=shirt');
    await userEvent.click(screen.getByRole('button', { name: 'clear' }));
    expect(env.replace).toHaveBeenLastCalledWith('/weldcommerce/categories');
  });
});
