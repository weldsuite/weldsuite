import { ProductGrid } from '../components/product-card';
import { COLUMN_OPTIONS } from '../components/scheme';
import { sectionDataKey, useShop } from '../context';
import { sectionSettings } from '../settings';
import { headingId, type SectionProps } from './types';

/** Products from the same category as the product page's own. */
export function RelatedProducts({ section, attributes, list }: Readonly<SectionProps>) {
  const { data } = useShop();
  const settings = sectionSettings(section.type, section.settings);
  const products = data.sections?.[sectionDataKey(list, section.id)]?.products ?? [];
  if (products.length === 0) return null;
  const heading = settings.text('heading').trim();
  const labelId = headingId({ list, section });
  return (
    <section {...attributes} aria-labelledby={heading ? labelId : undefined} className="shop-container shop-section flex flex-col gap-8 border-t border-shop-border">
      {heading ? (
        <h2 id={labelId} className="text-2xl font-semibold">
          {heading}
        </h2>
      ) : null}
      <ProductGrid products={products} columns={settings.choice('columns', COLUMN_OPTIONS)} headingLevel={heading ? 3 : 2} />
    </section>
  );
}
