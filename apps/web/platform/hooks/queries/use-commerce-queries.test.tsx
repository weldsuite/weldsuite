import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({ getClient: async () => api }),
}));

import {
  commerceKeys,
  useAttachCategoryProducts,
  useCategoryMembersPreview,
  useCommerceCategories,
  useCommerceCategory,
  useCommerceCategoryProducts,
  useCommerceCategoryTree,
  useCreateCommerceCategory,
  useCreateProductVariant,
  useDeleteCommerceCategory,
  useDeleteProductVariant,
  useDetachCategoryProduct,
  useGenerateProductVariants,
  useInfiniteCommerceCategories,
  useProductCategories,
  useProductVariants,
  useUpdateCommerceCategory,
  useUpdateProductVariant,
} from './use-commerce-queries';
import { weldstashKeys } from './use-weldstash-queries';

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  for (const fn of Object.values(api)) fn.mockReset();
  api.get.mockResolvedValue({ data: [], pagination: { totalCount: 0, hasMore: false, cursor: null } });
  api.post.mockResolvedValue({ data: {} });
  api.patch.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue(undefined);
});

function invalidated() {
  const spy = vi.spyOn(client, 'invalidateQueries');
  return () => spy.mock.calls.map(([filters]) => filters?.queryKey);
}

describe('variant hooks', () => {
  it('reads the variants of a product, and nothing without an id', async () => {
    const { result } = renderHook(() => useProductVariants('prod_1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.get).toHaveBeenCalledWith('/products/prod_1/variants');

    renderHook(() => useProductVariants(''), { wrapper });
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('creates, generates, updates and deletes, refreshing the variants and the WeldStash product rows', async () => {
    const keys = invalidated();
    const create = renderHook(() => useCreateProductVariant(), { wrapper }).result;
    const generate = renderHook(() => useGenerateProductVariants(), { wrapper }).result;
    const update = renderHook(() => useUpdateProductVariant(), { wrapper }).result;
    const remove = renderHook(() => useDeleteProductVariant(), { wrapper }).result;

    await act(() => create.current.mutateAsync({ productId: 'prod_1', data: { optionValues: { Size: 'L' } } }));
    expect(api.post).toHaveBeenCalledWith('/products/prod_1/variants', { optionValues: { Size: 'L' } });

    const options = [{ name: 'Size', values: ['S', 'M'] }];
    await act(() => generate.current.mutateAsync({ productId: 'prod_1', options }));
    expect(api.post).toHaveBeenCalledWith('/products/prod_1/variants/generate', { options });

    await act(() => update.current.mutateAsync({ productId: 'prod_1', variantId: 'var_1', data: { price: null } }));
    expect(api.patch).toHaveBeenCalledWith('/products/prod_1/variants/var_1', { price: null });

    await act(() => remove.current.mutateAsync({ productId: 'prod_1', variantId: 'var_1' }));
    expect(api.delete).toHaveBeenCalledWith('/products/prod_1/variants/var_1');

    expect(keys()).toContainEqual(commerceKeys.variants('prod_1'));
    expect(keys()).toContainEqual(weldstashKeys.products());
  });
});

describe('category hooks', () => {
  it('reads a product’s categories, the tree, one category and a filtered list', async () => {
    const productCategories = renderHook(() => useProductCategories('prod_1'), { wrapper }).result;
    const tree = renderHook(() => useCommerceCategoryTree(), { wrapper }).result;
    const one = renderHook(() => useCommerceCategory('cat_1'), { wrapper }).result;
    const list = renderHook(() => useCommerceCategories({ parentId: 'cat_1', limit: 100 }), { wrapper }).result;
    await waitFor(() => expect(list.current.isSuccess && tree.current.isSuccess).toBe(true));
    await waitFor(() => expect(one.current.isSuccess && productCategories.current.isSuccess).toBe(true));
    expect(api.get).toHaveBeenCalledWith('/products/prod_1/categories');
    expect(api.get).toHaveBeenCalledWith('/categories/tree');
    expect(api.get).toHaveBeenCalledWith('/categories/cat_1');
    expect(api.get).toHaveBeenCalledWith('/categories?parentId=cat_1&limit=100');
  });

  it('pages the searched list with the cursor', async () => {
    api.get.mockResolvedValueOnce({ data: [{ id: 'cat_1' }], pagination: { totalCount: 2, hasMore: true, cursor: 'c2' } });
    const { result } = renderHook(() => useInfiniteCommerceCategories({ search: 'shirt', limit: 50 }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.get).toHaveBeenCalledWith('/categories?search=shirt&limit=50');
    expect(result.current.hasNextPage).toBe(true);
    await act(() => result.current.fetchNextPage());
    expect(api.get).toHaveBeenLastCalledWith('/categories?search=shirt&limit=50&cursor=c2');
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
  });

  it('does not search while the list is off', () => {
    renderHook(() => useInfiniteCommerceCategories({ search: '' }, false), { wrapper });
    expect(api.get).not.toHaveBeenCalled();
  });

  it('creates, updates and deletes categories, refreshing every category query', async () => {
    const keys = invalidated();
    const create = renderHook(() => useCreateCommerceCategory(), { wrapper }).result;
    const update = renderHook(() => useUpdateCommerceCategory(), { wrapper }).result;
    const remove = renderHook(() => useDeleteCommerceCategory(), { wrapper }).result;

    await act(() => create.current.mutateAsync({ name: 'Shirts', type: 'manual' }));
    expect(api.post).toHaveBeenCalledWith('/categories', { name: 'Shirts', type: 'manual' });
    await act(() => update.current.mutateAsync({ id: 'cat_1', data: { parentId: null } }));
    expect(api.patch).toHaveBeenCalledWith('/categories/cat_1', { parentId: null });
    await act(() => remove.current.mutateAsync('cat_1'));
    expect(api.delete).toHaveBeenCalledWith('/categories/cat_1');

    expect(keys()).toContainEqual(commerceKeys.categories());
    expect(keys()).toContainEqual([...commerceKeys.all, 'products']);
  });
});

describe('category member hooks', () => {
  it('pages a category’s products', async () => {
    api.get.mockResolvedValueOnce({ data: [{ id: 'prod_1' }], pagination: { totalCount: 2, hasMore: true, cursor: 'p2' } });
    const { result } = renderHook(() => useCommerceCategoryProducts('cat_1'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.get).toHaveBeenCalledWith('/categories/cat_1/products');
    await act(() => result.current.fetchNextPage());
    expect(api.get).toHaveBeenLastCalledWith('/categories/cat_1/products?cursor=p2');
  });

  it('adds and removes members, refreshing the category and the products’ category lists', async () => {
    const keys = invalidated();
    const attach = renderHook(() => useAttachCategoryProducts(), { wrapper }).result;
    const detach = renderHook(() => useDetachCategoryProduct(), { wrapper }).result;

    await act(() => attach.current.mutateAsync({ categoryId: 'cat_1', productIds: ['prod_1', 'prod_2'] }));
    expect(api.post).toHaveBeenCalledWith('/categories/cat_1/products', { productIds: ['prod_1', 'prod_2'] });
    await act(() => detach.current.mutateAsync({ categoryId: 'cat_1', productId: 'prod_1' }));
    expect(api.delete).toHaveBeenCalledWith('/categories/cat_1/products/prod_1');

    expect(keys()).toContainEqual(commerceKeys.categoryProducts('cat_1'));
    expect(keys()).toContainEqual(commerceKeys.productCategories('prod_2'));
  });

  it('previews the members of unsaved rules, and asks nothing for incomplete ones', async () => {
    renderHook(() => useCategoryMembersPreview(null), { wrapper });
    expect(api.post).not.toHaveBeenCalled();

    const input = { rules: [{ column: 'name' as const, relation: 'contains' as const, condition: 'shirt' }], rulesMatch: 'all' as const };
    api.post.mockResolvedValueOnce({ data: { totalCount: 0, products: [] } });
    const { result } = renderHook(() => useCategoryMembersPreview(input), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.post).toHaveBeenCalledWith('/categories/preview-members', input);
  });
});
