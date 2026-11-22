import type { StorefrontProduct } from '@weldsuite/commerce-sdk';
import Link from 'next/link';

import { Price } from './price';

/**
 * A product in a grid: an article whose heading link covers the whole card
 * (one destination, so one link; the image is decorative next to the name).
 */
export function ProductCard({
  product,
  locale,
  eager = false,
}: Readonly<{
  product: StorefrontProduct;
  locale: string;
  /** The first cards of a page are above the fold: don't lazy-load them. */
  eager?: boolean;
}>) {
  const image = product.featuredImageUrl ?? product.images[0]?.url ?? null;
  const fromPrice = product.variants.length > 1 && new Set(product.variants.map((v) => v.price)).size > 1;
  return (
    <article className="group relative flex flex-col gap-3 rounded-xl border border-line p-3 transition-colors has-[a:focus-visible]:outline-3 has-[a:focus-visible]:outline-brand has-[a:hover]:border-line-strong">
      {image ? (
        <img
          src={image}
          alt=""
          width={600}
          height={600}
          loading={eager ? undefined : 'lazy'}
          decoding="async"
          className="aspect-square w-full rounded-lg bg-surface-muted object-cover"
        />
      ) : (
        <div aria-hidden="true" className="aspect-square w-full rounded-lg bg-surface-muted" />
      )}
      <h3 className="font-medium leading-snug">
        <Link href={`/products/${encodeURIComponent(product.slug || product.id)}`} className="card-link focus-visible:outline-none">
          {product.name}
        </Link>
      </h3>
      <p className="mt-auto flex flex-wrap items-baseline gap-x-2">
        {fromPrice ? <span className="text-sm text-ink-muted">From</span> : null}
        <Price amount={product.price} compareAt={product.compareAtPrice} currency={product.currency} locale={locale} />
        {!product.available ? <span className="text-sm text-danger">Sold out</span> : null}
      </p>
    </article>
  );
}

export function ProductGrid({ products, locale }: Readonly<{ products: StorefrontProduct[]; locale: string }>) {
  return (
    // role="list": Safari/VoiceOver drops list semantics from lists styled with list-style: none.
    <ul role="list" className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,14rem),1fr))] gap-4">
      {products.map((product, index) => (
        <li key={product.id} className="flex">
          <div className="w-full">
            <ProductCard product={product} locale={locale} eager={index < 4} />
          </div>
        </li>
      ))}
    </ul>
  );
}
