import type { ProductSort } from '@weldsuite/commerce-sdk';
import Link from 'next/link';

import { requestOptions, shopLocale, storefront } from '@/lib/commerce';
import { single } from '@/lib/params';

import { ProductGrid } from './product-card';

const SORTS: Array<{ value: ProductSort; label: string }> = [
  { value: 'name', label: 'Name, A to Z' },
  { value: '-name', label: 'Name, Z to A' },
  { value: 'price', label: 'Price, low to high' },
  { value: '-price', label: 'Price, high to low' },
  { value: 'newest', label: 'Newest first' },
];

export function readSort(value: string | string[] | undefined): ProductSort {
  return SORTS.some((s) => s.value === value) ? (value as ProductSort) : 'name';
}

/**
 * A page of products with a sort control and "next page" (the API pages
 * with a cursor). `basePath` is the page's own path, for the links.
 */
export async function ProductListing({
  basePath,
  category,
  searchParams,
}: {
  basePath: string;
  category?: string;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const search = single(searchParams.search)?.slice(0, 100);
  const sort = readSort(searchParams.sort);
  const cursor = single(searchParams.cursor);
  const page = await storefront().products.list({ category, search, sort, cursor, limit: 24 }, await requestOptions());

  const link = (params: Record<string, string | undefined>) => {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries({ search, sort: sort === 'name' ? undefined : sort, ...params })) {
      if (value) query.set(name, value);
    }
    const text = query.toString();
    return text ? `${basePath}?${text}` : basePath;
  };

  return (
    <div className="flex flex-col gap-6">
      <form action={basePath} method="get" className="flex flex-wrap items-end gap-3">
        {search ? <input type="hidden" name="search" value={search} /> : null}
        <div className="field">
          <label htmlFor="sort">Sort by</label>
          <select id="sort" name="sort" defaultValue={sort}>
            {SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn btn-secondary">
          Sort
        </button>
      </form>

      {page.data.length === 0 ? (
        <p className="rounded-lg bg-surface-muted p-6">
          {search ? `Nothing matches “${search}”. Try another word.` : 'There are no products here yet.'}
        </p>
      ) : (
        <ProductGrid products={page.data} locale={shopLocale} />
      )}

      {cursor || page.pagination.hasMore ? (
        <nav aria-label="Pages" className="flex flex-wrap justify-between gap-3">
          {cursor ? (
            <Link href={link({})} className="btn btn-secondary">
              Back to the first page
            </Link>
          ) : (
            <span />
          )}
          {page.pagination.hasMore && page.pagination.cursor ? (
            <Link href={link({ cursor: page.pagination.cursor })} className="btn btn-secondary">
              Next page
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
