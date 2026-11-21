import { isStorefrontError, type ProductImage, type StorefrontProduct } from '@weldsuite/commerce-sdk';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache } from 'react';

import { AddToCartForm } from '@/components/add-to-cart-form';
import { requestOptions, shopLocale, storefront } from '@/lib/commerce';
import { getChannel } from '@/lib/data';
import { segment } from '@/lib/params';

type Props = { params: Promise<{ slug: string }> };

const getProduct = cache(async (idOrSlug: string) => {
  try {
    return await storefront().products.get(idOrSlug, await requestOptions());
  } catch (error) {
    if (isStorefrontError(error, 'NOT_FOUND')) notFound();
    throw error;
  }
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const product = await getProduct(segment((await params).slug));
  const image = product.featuredImageUrl ?? product.images[0]?.url;
  return {
    title: product.name,
    description: product.description?.slice(0, 160) ?? undefined,
    openGraph: image ? { images: [image] } : undefined,
  };
}

/** The product's images; the featured image alone when it has no gallery. */
function galleryOf(product: StorefrontProduct): ProductImage[] {
  if (product.images.length > 0) return product.images;
  return product.featuredImageUrl ? [{ url: product.featuredImageUrl, altText: null }] : [];
}

export default async function ProductPage({ params }: Props) {
  const [product, channel] = await Promise.all([getProduct(segment((await params).slug)), getChannel()]);
  const [main, ...more] = galleryOf(product);
  const category = product.categories[0];

  return (
    <div className="flex flex-col gap-6">
      {category ? (
        <nav aria-label="Breadcrumb">
          <ol role="list" className="flex flex-wrap gap-2 text-sm text-ink-muted">
            <li>
              <Link href="/products" className="hover:underline">
                Products
              </Link>
              <span aria-hidden="true"> /</span>
            </li>
            <li>
              <Link href={`/categories/${encodeURIComponent(category.slug)}`} className="hover:underline">
                {category.name}
              </Link>
              <span aria-hidden="true"> /</span>
            </li>
            <li>
              <span aria-current="page">{product.name}</span>
            </li>
          </ol>
        </nav>
      ) : null}

      <div className="grid gap-8 md:grid-cols-2">
        <div className="flex flex-col gap-3">
          {main ? (
            <img
              src={main.url}
              alt={main.altText ?? product.name}
              width={800}
              height={800}
              fetchPriority="high"
              className="aspect-square w-full rounded-2xl bg-surface-muted object-cover"
            />
          ) : (
            <div aria-hidden="true" className="aspect-square w-full rounded-2xl bg-surface-muted" />
          )}
          {more.length > 0 ? (
            <ul role="list" className="grid grid-cols-4 gap-3">
              {more.map((image) => (
                <li key={image.url}>
                  <img
                    src={image.url}
                    alt={image.altText ?? ''}
                    width={200}
                    height={200}
                    loading="lazy"
                    decoding="async"
                    className="aspect-square w-full rounded-lg bg-surface-muted object-cover"
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <h1 className="text-3xl font-semibold text-balance">{product.name}</h1>
            <p className="text-sm text-ink-muted">{channel.pricesIncludeTax ? 'Price includes VAT.' : 'Price excludes VAT.'}</p>
          </div>
          <AddToCartForm product={product} locale={shopLocale} />
          {product.description ? (
            <section aria-labelledby="about" className="flex flex-col gap-2">
              <h2 id="about" className="text-lg font-semibold">
                About this product
              </h2>
              {/* Plain text on purpose: sanitise first if your descriptions are HTML. */}
              <p className="max-w-prose whitespace-pre-line">{product.description}</p>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
