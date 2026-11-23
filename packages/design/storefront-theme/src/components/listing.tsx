import type { ProductSort } from '@weldsuite/commerce-sdk';
import { useId } from 'react';
import { useShop, type ProductListing } from '../context';
import { ProductGrid } from './product-card';
import { ShopLink } from './shop-link';

export const SORTS: ProductSort[] = ['name', '-name', 'price', '-price', 'newest'];

/** Sort order: a select and a button (changing the select alone never submits). */
export function SortForm({ listing }: Readonly<{ listing: ProductListing }>) {
  const { shop } = useShop();
  const id = useId();
  const s = shop.strings.listing;
  const sorts = shop.showPrices ? SORTS : SORTS.filter((sort) => sort !== 'price' && sort !== '-price');
  return (
    <form action={listing.path} method="get" className="flex items-end gap-2">
      {listing.kind === 'search' ? <input type="hidden" name="q" value={listing.query} /> : null}
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="shop-label text-sm">
          {s.sortLabel}
        </label>
        <select id={id} name="sort" defaultValue={listing.sort} className="shop-input">
          {sorts.map((sort) => (
            <option key={sort} value={sort}>
              {s.sort[sort]}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className="shop-btn shop-btn-secondary">
        {s.applySort}
      </button>
    </form>
  );
}

/** The products of a listing, then links to the next and the first page. */
export function ListingResults({
  listing,
  columns,
  emptyText,
  cardHeadingLevel = 2,
}: Readonly<{ listing: ProductListing; columns: string; emptyText: string; cardHeadingLevel?: 2 | 3 }>) {
  const { shop } = useShop();
  const s = shop.strings.listing;
  if (listing.products.length === 0) return <p className="py-8">{emptyText}</p>;
  return (
    <div className="flex flex-col gap-10">
      <ProductGrid products={listing.products} columns={columns} headingLevel={cardHeadingLevel} />
      {listing.nextHref || listing.firstHref ? (
        <nav aria-label={s.morePages} className="flex flex-wrap justify-center gap-3">
          {listing.firstHref ? (
            <ShopLink href={listing.firstHref} className="shop-btn shop-btn-secondary">
              {s.firstPage}
            </ShopLink>
          ) : null}
          {listing.nextHref ? (
            <ShopLink href={listing.nextHref} className="shop-btn shop-btn-primary">
              {s.morePages}
            </ShopLink>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
