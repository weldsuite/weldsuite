import type { StorefrontProduct } from '@weldsuite/commerce-sdk';
import { Link } from 'react-router';

import { productPath } from '../lib/urls';
import { text } from '../lib/messages';
import { Price } from './price';

/** One product in a grid; the whole card is the link (the name is its text). */
export function ProductCard({ product }: Readonly<{ product: StorefrontProduct }>) {
  const image = product.featuredImageUrl ?? product.images[0]?.url ?? null;
  const prices = new Set(product.variants.map((variant) => variant.price));
  return (
    <li className="relative flex flex-col gap-3">
      <div className="aspect-square overflow-hidden rounded-xl bg-surface-muted">
        {image ? <img src={image} alt="" loading="lazy" decoding="async" className="size-full object-cover" /> : null}
      </div>
      <h3 className="font-medium">
        <Link to={productPath(product.slug)} className="card-link">
          {product.name}
        </Link>
      </h3>
      <Price amount={product.price} compareAt={product.compareAtPrice} currency={product.currency} from={prices.size > 1} />
      {product.available ? null : <span className="hint">{text.soldOut}</span>}
    </li>
  );
}

export function ProductGrid({ products, label }: Readonly<{ products: StorefrontProduct[]; label?: string }>) {
  return (
    <ul role="list" aria-label={label} className="grid grid-cols-2 gap-x-4 gap-y-8 sm:gap-x-6 lg:grid-cols-4">
      {products.map((product) => (
        <ProductCard key={product.id} product={product} />
      ))}
    </ul>
  );
}
