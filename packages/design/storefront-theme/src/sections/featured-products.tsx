import { Heading } from '../components/heading';
import { ProductGrid } from '../components/product-card';
import { COLUMN_OPTIONS } from '../components/scheme';
import { ShopLink } from '../components/shop-link';
import { sectionDataKey, useShop } from '../context';
import { sectionSettings } from '../settings';
import { headingId, type SectionProps } from './types';

/** A few products: the newest, a category's, or chosen ones (the renderer loads them). */
export function FeaturedProducts({ section, attributes, headingLevel, list }: Readonly<SectionProps>) {
  const { shop, data } = useShop();
  const settings = sectionSettings(section.type, section.settings);
  const products = data.sections?.[sectionDataKey(list, section.id)]?.products ?? [];
  if (products.length === 0) {
    return shop.preview ? (
      <section {...attributes} className="shop-container shop-section">
        <p className="shop-hint">{shop.strings.preview.emptySection}</p>
      </section>
    ) : null;
  }
  const heading = settings.text('heading').trim();
  const labelId = headingId({ list, section });
  const category = settings.choice('source', ['newest', 'category', 'products'] as const) === 'category' ? settings.text('category') : '';
  const viewAll = category ? `/categories/${encodeURIComponent(category)}` : '/products';
  return (
    <section {...attributes} aria-labelledby={heading ? labelId : undefined} className="shop-container shop-section flex flex-col gap-8">
      {heading || settings.bool('showViewAll') ? (
        <div className="flex flex-wrap items-end justify-between gap-4">
          {heading ? (
            <Heading level={headingLevel} id={labelId} className="text-2xl font-semibold md:text-3xl">
              {heading}
            </Heading>
          ) : null}
          {settings.bool('showViewAll') ? (
            <ShopLink href={viewAll} className="font-medium underline underline-offset-4">
              {shop.strings.common.viewAll}
            </ShopLink>
          ) : null}
        </div>
      ) : null}
      <ProductGrid products={products} columns={settings.choice('columns', COLUMN_OPTIONS)} headingLevel={heading ? 3 : 2} />
    </section>
  );
}
