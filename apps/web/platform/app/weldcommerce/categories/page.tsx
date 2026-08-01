/**
 * Categories list.
 *
 * Two sources, picked by whether a search is active:
 *
 * - **No search** → `/categories/tree`, flattened depth-first, so parents sit
 *   directly above their children and the name column can indent by depth.
 *   The tree endpoint returns the whole forest, so there is nothing to page.
 * - **Searching** → the flat cursor-paged `/categories` list. A match set is
 *   not a tree — indenting a child whose parent didn't match would imply a
 *   nesting the visible rows don't contain — so hierarchy is off there.
 */

import { Suspense, useMemo, useCallback } from 'react';
import { useRouter, useSearchParams } from '@/lib/router';
import { PageLoader } from '@/components/page-loader';
import {
  useInfiniteCommerceCategories,
  useCommerceCategoryTree,
  flattenCategoryTree,
  type CommerceCategory,
} from '@/hooks/queries/use-commerce-queries';
import { CategoriesList } from './components/categories-list';

function CategoriesPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const search = searchParams.get('search') || '';
  const isSearching = search.length > 0;

  const setSearch = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) params.set('search', value);
      else params.delete('search');
      const qs = params.toString();
      router.replace(`/weldcommerce/categories${qs ? `?${qs}` : ''}`);
    },
    [router, searchParams],
  );

  const treeQuery = useCommerceCategoryTree();
  const searchQuery = useInfiniteCommerceCategories(
    useMemo(() => ({ limit: 50, search }), [search]),
  );

  const treeRows = useMemo(
    () => flattenCategoryTree(treeQuery.data?.data ?? []),
    [treeQuery.data],
  );
  const searchRows = useMemo<CommerceCategory[]>(
    () => searchQuery.data?.pages.flatMap((p) => p.data ?? []) ?? [],
    [searchQuery.data],
  );

  const handleLoadMore = useCallback(() => {
    if (searchQuery.hasNextPage && !searchQuery.isFetchingNextPage) searchQuery.fetchNextPage();
  }, [searchQuery]);

  return (
    <CategoriesList
      categories={isSearching ? searchRows : treeRows}
      isLoading={isSearching ? searchQuery.isLoading : treeQuery.isLoading}
      search={search}
      onSearchChange={setSearch}
      showHierarchy={!isSearching}
      onLoadMore={isSearching ? handleLoadMore : undefined}
      hasMore={isSearching ? !!searchQuery.hasNextPage : false}
      isFetchingMore={isSearching ? searchQuery.isFetchingNextPage : false}
    />
  );
}

export default function CommerceCategoriesPage() {
  return (
    <Suspense fallback={<PageLoader fullScreen={false} />}>
      <CategoriesPageContent />
    </Suspense>
  );
}
