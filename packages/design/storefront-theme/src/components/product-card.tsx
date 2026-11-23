import type { StorefrontProduct } from '@weldsuite/commerce-sdk';
import { useShop } from '../context';
import { columnsClass } from './scheme';
import { Price } from './price';
import { ShopLink } from './shop-link';
import { ThemeImage } from './theme-image';

/** The path of a product page. */
export function productPath(product: Pick<StorefrontProduct, 'slug' | 'id'>): string {
  return `/products/${encodeURIComponent(product.slug || product.id)}`;
}

/** One product in a grid: image, name (the link), price, sold out. */
export function ProductCard({ product, headingLevel = 3 }: Readonly<{ product: StorefrontProduct; headingLevel?: 2 | 3 }>) {
  const { shop } = useShop();
  const image = product.images[0];
  const src = product.featuredImageUrl ?? image?.url ?? null;
  const Title = headingLevel === 2 ? 'h2' : 'h3';
  const prices = new Set(product.variants.map((variant) => variant.price));
  return (
    <li className="group relative flex flex-col gap-3">
      <div className="aspect-square overflow-hidden rounded-shop bg-shop-muted">
        {src ? (
          <ThemeImage
            src={src}
            alt=""
            className="size-full object-cover transition-transform duration-300 motion-safe:group-hover:scale-105"
            sizes="(min-width: 1024px) 25vw, 50vw"
          />
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        <Title className="text-base font-medium leading-snug">
          {/* The whole card is clickable through the link's ::after; the link text is the name. */}
          <ShopLink href={productPath(product)} className="after:absolute after:inset-0 after:content-['']">
            {product.name}
          </ShopLink>
        </Title>
        <Price amount={product.price} compareAt={product.compareAtPrice} currency={product.currency} from={prices.size > 1} />
        {!product.available ? <span className="shop-hint">{shop.strings.product.soldOut}</span> : null}
      </div>
    </li>
  );
}

/** Products in a responsive grid. */
export function ProductGrid({
  products,
  columns = '4',
  headingLevel = 3,
  label,
}: Readonly<{ products: StorefrontProduct[]; columns?: string; headingLevel?: 2 | 3; label?: string }>) {
  return (
    // role="list": Safari drops list semantics from lists styled with list-style: none.
    // eslint-disable-next-line jsx-a11y/no-redundant-roles
    <ul role="list" aria-label={label} className={`grid gap-x-4 gap-y-8 sm:gap-x-6 ${columnsClass(columns)}`}>
      {products.map((product) => (
        <ProductCard key={product.id} product={product} headingLevel={headingLevel} />
      ))}
    </ul>
  );
}
