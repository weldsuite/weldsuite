import type { ProductImage, StorefrontProduct } from '@weldsuite/commerce-sdk';
import { useState, type ReactNode } from 'react';
import { Breadcrumbs } from '../components/breadcrumbs';
import { ProductBuyFields } from '../components/buy-fields';
import { ShopLink } from '../components/shop-link';
import { ThemeImage } from '../components/theme-image';
import { useShop } from '../context';
import { sectionSettings } from '../settings';
import { format } from '../strings';
import type { SectionProps } from './types';

function imagesOf(product: StorefrontProduct): ProductImage[] {
  if (product.images.length > 0) return product.images;
  return product.featuredImageUrl ? [{ url: product.featuredImageUrl, altText: null }] : [];
}

function Gallery({ product, mode, priority }: Readonly<{ product: StorefrontProduct; mode: 'thumbnails' | 'stacked'; priority: boolean }>) {
  const { shop } = useShop();
  const images = imagesOf(product);
  const [active, setActive] = useState(0);
  if (images.length === 0) return <div className="aspect-square rounded-shop bg-shop-muted" />;
  const alt = (image: ProductImage) => image.altText?.trim() || product.name;
  if (mode === 'stacked') {
    return (
      <div className="flex flex-col gap-4">
        {images.map((image, index) => (
          <ThemeImage
            key={image.url}
            src={image.url}
            alt={alt(image)}
            priority={priority && index === 0}
            className="w-full rounded-shop bg-shop-muted object-cover"
            sizes="(min-width: 768px) 50vw, 100vw"
          />
        ))}
      </div>
    );
  }
  const current = images[Math.min(active, images.length - 1)]!;
  return (
    <div className="flex flex-col gap-3">
      <div className="aspect-square overflow-hidden rounded-shop bg-shop-muted">
        <ThemeImage src={current.url} alt={alt(current)} priority={priority && active === 0} className="size-full object-cover" sizes="(min-width: 768px) 50vw, 100vw" />
      </div>
      {images.length > 1 ? (
        <ul className="flex flex-wrap gap-2" aria-label={shop.strings.product.images}>
          {images.map((image, index) => (
            <li key={image.url}>
              <button
                type="button"
                onClick={() => setActive(index)}
                aria-pressed={index === active}
                className="block size-20 overflow-hidden rounded-shop border-2 border-transparent bg-shop-muted aria-pressed:border-shop-fg"
              >
                <ThemeImage src={image.url} alt="" className="size-full object-cover" />
                <span className="sr-only">{format(shop.strings.product.showImage, { index: index + 1 })}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** A product's description: plain text, paragraphs on blank lines (never HTML). */
function Description({ text }: Readonly<{ text: string }>) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  return (
    <div className="shop-prose">
      {paragraphs.map((paragraph, index) => (
        <p key={index} className="whitespace-pre-line">
          {paragraph}
        </p>
      ))}
    </div>
  );
}

/** The product page's main section: gallery, name, price, buy form, description. */
export function MainProduct({ section, attributes, priority }: Readonly<SectionProps>) {
  const { shop, data, slots } = useShop();
  const settings = sectionSettings(section.type, section.settings);
  const product = data.product;
  const s = shop.strings.product;
  if (!product) {
    return (
      <section {...attributes} className="shop-container shop-section">
        <h1 className="text-3xl font-semibold">{s.notFound}</h1>
      </section>
    );
  }
  const category = product.categories[0];
  const AddToCart = slots.AddToCart;
  const showSku = settings.bool('showSku');
  const path = `/products/${encodeURIComponent(product.slug)}`;
  // Prices hidden from guests: a way to sign in instead of the buy form.
  let buy: ReactNode;
  if (!shop.showPrices) {
    buy = (
      <p>
        <ShopLink href={`/account?next=${encodeURIComponent(path)}`} className="shop-btn shop-btn-primary">
          {shop.strings.account.signInToSeePrices}
        </ShopLink>
      </p>
    );
  } else if (AddToCart) {
    buy = <AddToCart product={product} showSku={showSku} />;
  } else {
    buy = <ProductBuyFields product={product} showSku={showSku} />;
  }
  return (
    <section {...attributes} aria-labelledby="product-title" className="shop-container shop-section">
      <Breadcrumbs
        trail={[
          { label: shop.strings.common.home, href: '/' },
          ...(category ? [{ label: category.name, href: `/categories/${encodeURIComponent(category.slug)}` }] : []),
          { label: product.name, href: path },
        ]}
      />
      <div className="mt-6 grid gap-8 md:grid-cols-2 md:gap-12">
        <Gallery product={product} mode={settings.choice('gallery', ['thumbnails', 'stacked'] as const)} priority={priority} />
        <div className="flex flex-col gap-6">
          <h1 id="product-title" className="text-3xl font-semibold md:text-4xl">
            {product.name}
          </h1>
          {buy}
          {settings.bool('showDescription') && product.description ? (
            <div className="flex flex-col gap-2 border-t border-shop-border pt-6">
              <h2 className="text-lg font-semibold">{s.description}</h2>
              <Description text={product.description} />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

