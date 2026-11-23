import { isStorefrontError, type Page, type ProductSort, type StorefrontCategory, type StorefrontProduct } from '@weldsuite/commerce-sdk';
import { useId } from 'react';
import { data, Form, Link, useLoaderData, type LoaderFunctionArgs } from 'react-router';

import { PageMeta } from '../components/page-meta';
import { ProductGrid } from '../components/product-card';
import { storefront } from '../lib/client';
import { text } from '../lib/messages';
import { categoryPath } from '../lib/urls';

const SORTS: ProductSort[] = ['name', '-name', 'price', '-price', 'newest'];

interface ListingData {
  category: StorefrontCategory | null;
  search: string;
  sort: ProductSort;
  page: Page<StorefrontProduct>;
  /** The listing's own path, without query. */
  path: string;
  /** Whether this is a later page. */
  paged: boolean;
}

/** `/products` (with `?search=`) and `/categories/:slug`: one page of products, sorted, with a cursor. */
export async function loader({ request, params }: LoaderFunctionArgs): Promise<ListingData> {
  const url = new URL(request.url);
  const sortParam = url.searchParams.get('sort');
  const sort = SORTS.find((candidate) => candidate === sortParam) ?? 'name';
  const search = (url.searchParams.get('search') ?? '').trim().slice(0, 100);
  const cursor = url.searchParams.get('cursor') ?? undefined;
  let category: StorefrontCategory | null = null;
  if (params.slug) {
    try {
      category = await storefront().categories.get(params.slug);
    } catch (error) {
      if (isStorefrontError(error, 'NOT_FOUND')) throw data(null, { status: 404 });
      throw error;
    }
  }
  const list = (from: string | undefined) =>
    storefront().products.list({ sort, limit: 24, cursor: from, category: category?.id, search: search || undefined });
  let page: Page<StorefrontProduct>;
  try {
    page = await list(cursor);
  } catch (error) {
    if (!cursor || !isStorefrontError(error, 'INVALID_CURSOR')) throw error;
    page = await list(undefined);
  }
  return { category, search, sort, page, path: category ? categoryPath(category.slug) : '/products', paged: Boolean(cursor) };
}

function SortForm({ listing }: Readonly<{ listing: ListingData }>) {
  const id = useId();
  return (
    <Form method="get" action={listing.path} className="flex items-end gap-2">
      {listing.search ? <input type="hidden" name="search" value={listing.search} /> : null}
      <div className="field">
        <label htmlFor={id}>{text.sortBy}</label>
        <select id={id} name="sort" defaultValue={listing.sort}>
          {SORTS.map((sort) => (
            <option key={sort} value={sort}>
              {text.sorts[sort]}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className="btn btn-secondary">
        {text.sortApply}
      </button>
    </Form>
  );
}

function pageHref(listing: ListingData, cursor: string | null): string {
  const query = new URLSearchParams();
  if (listing.search) query.set('search', listing.search);
  if (listing.sort !== 'name') query.set('sort', listing.sort);
  if (cursor) query.set('cursor', cursor);
  const search = query.toString();
  return search ? `${listing.path}?${search}` : listing.path;
}

export function Component() {
  const listing = useLoaderData() as ListingData;
  const { category, search, page } = listing;
  const title = category?.name ?? (search ? text.searchResults(search) : text.allProducts);
  return (
    <div className="flex flex-col gap-8">
      <PageMeta title={title} description={category?.description} path={search ? undefined : listing.path} />
      {search ? <meta name="robots" content="noindex" /> : null}
      <div className="flex flex-col gap-3">
        <h1 className="text-3xl font-semibold">{title}</h1>
        {category?.description ? <p className="max-w-prose text-ink-muted">{category.description}</p> : null}
      </div>
      {category && category.children.length > 0 ? (
        <nav aria-label={text.categoriesNav}>
          <ul role="list" className="flex flex-wrap gap-2">
            {category.children.map((child) => (
              <li key={child.id}>
                <Link to={categoryPath(child.slug)} className="btn btn-secondary">
                  {child.name}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      {page.data.length > 1 ? <SortForm listing={listing} /> : null}
      {page.data.length > 0 ? <ProductGrid products={page.data} /> : <p>{search ? text.noResults(search) : text.noProducts}</p>}
      {listing.paged || page.pagination.hasMore ? (
        <nav aria-label={text.morePages} className="flex flex-wrap justify-center gap-3">
          {listing.paged ? (
            <Link to={pageHref(listing, null)} className="btn btn-secondary">
              {text.firstPage}
            </Link>
          ) : null}
          {page.pagination.hasMore && page.pagination.cursor ? (
            <Link to={pageHref(listing, page.pagination.cursor)} className="btn btn-primary">
              {text.morePages}
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
