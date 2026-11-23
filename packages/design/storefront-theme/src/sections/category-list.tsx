import type { StorefrontCategory } from '@weldsuite/commerce-sdk';
import { Heading } from '../components/heading';
import { columnsClass, COLUMN_OPTIONS } from '../components/scheme';
import { ShopLink } from '../components/shop-link';
import { useShop } from '../context';
import { sectionSettings } from '../settings';
import { headingId, type SectionProps } from './types';

/** Every category in the tree, depth first. */
function flatten(categories: StorefrontCategory[]): StorefrontCategory[] {
  return categories.flatMap((category) => [category, ...flatten(category.children)]);
}

/** Links to categories: the chosen ones in their order, or the top-level ones. */
export function CategoryList({ section, attributes, headingLevel, list }: Readonly<SectionProps>) {
  const { shop, data } = useShop();
  const settings = sectionSettings(section.type, section.settings);
  const tree = data.categories ?? [];
  const chosen = settings.list('categories');
  const all = flatten(tree);
  const categories = chosen.length > 0
    ? chosen.flatMap((ref) => all.filter((category) => category.id === ref || category.slug === ref).slice(0, 1))
    : tree;
  if (categories.length === 0) {
    return shop.preview ? (
      <section {...attributes} className="shop-container shop-section">
        <p className="shop-hint">{shop.strings.preview.emptySection}</p>
      </section>
    ) : null;
  }
  const heading = settings.text('heading').trim();
  const labelId = headingId({ list, section });
  return (
    <section {...attributes} aria-labelledby={heading ? labelId : undefined} className="shop-container shop-section flex flex-col gap-8">
      {heading ? (
        <Heading level={headingLevel} id={labelId} className="text-2xl font-semibold md:text-3xl">
          {heading}
        </Heading>
      ) : null}
      {/* eslint-disable-next-line jsx-a11y/no-redundant-roles -- Safari drops list semantics from unstyled lists */}
      <ul role="list" className={`grid gap-4 ${columnsClass(settings.choice('columns', COLUMN_OPTIONS))}`}>
        {categories.map((category) => (
          <li key={category.id}>
            <ShopLink
              href={`/categories/${encodeURIComponent(category.slug)}`}
              className="flex min-h-28 flex-col justify-end gap-1 rounded-shop border border-shop-border bg-shop-muted p-5 text-shop-on-muted transition-colors hover:border-shop-fg"
            >
              <span className="font-heading text-xl font-semibold">{category.name}</span>
              {category.description ? <span className="line-clamp-2 text-sm">{category.description}</span> : null}
            </ShopLink>
          </li>
        ))}
      </ul>
    </section>
  );
}
