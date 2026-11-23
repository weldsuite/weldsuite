import { Breadcrumbs } from '../components/breadcrumbs';
import { ListingResults, SortForm } from '../components/listing';
import { ShopLink } from '../components/shop-link';
import { COLUMN_OPTIONS } from '../components/scheme';
import { useShop } from '../context';
import { sectionSettings } from '../settings';
import type { SectionProps } from './types';

/** A category's products (or all products on `/products`), with sorting and pages. */
export function MainCategory({ section, attributes }: Readonly<SectionProps>) {
  const { shop, data } = useShop();
  const settings = sectionSettings(section.type, section.settings);
  const listing = data.listing;
  const s = shop.strings.listing;
  if (!listing) {
    return (
      <section {...attributes} className="shop-container shop-section">
        <h1 className="text-3xl font-semibold">{s.categoryNotFound}</h1>
      </section>
    );
  }
  const category = listing.category;
  const title = category?.name ?? s.allProducts;
  return (
    <section {...attributes} aria-labelledby="listing-title" className="shop-container shop-section flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <Breadcrumbs trail={[{ label: shop.strings.common.home, href: '/' }, { label: title, href: listing.path }]} />
        <h1 id="listing-title" className="text-3xl font-semibold md:text-4xl">
          {title}
        </h1>
        {settings.bool('showDescription') && category?.description ? (
          <p className="max-w-prose whitespace-pre-line text-shop-subtle">{category.description}</p>
        ) : null}
      </div>
      {category && category.children.length > 0 ? (
        <nav aria-label={s.subcategories}>
          <ul className="flex flex-wrap gap-2">
            {category.children.map((child) => (
              <li key={child.id}>
                <ShopLink href={`/categories/${encodeURIComponent(child.slug)}`} className="shop-btn shop-btn-secondary min-h-10 py-1.5 text-sm">
                  {child.name}
                </ShopLink>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      {settings.bool('showSort') && listing.products.length > 1 ? <SortForm listing={listing} /> : null}
      <ListingResults listing={listing} columns={settings.choice('columns', COLUMN_OPTIONS)} emptyText={s.empty} />
    </section>
  );
}
