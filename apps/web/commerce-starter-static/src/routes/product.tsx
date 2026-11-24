import { isStorefrontError, type CartItemInput, type ProductImage, type StorefrontProduct, type StorefrontVariant } from '@weldsuite/commerce-sdk';
import { useId, useState } from 'react';
import { data, Link, useFetcher, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router';

import { FormMessage, SubmitButton, type ActionState } from '../components/form-bits';
import { PageMeta } from '../components/page-meta';
import { Price } from '../components/price';
import { addToCart, field, wholeNumber } from '../lib/cart';
import { storefront } from '../lib/client';
import { describeError, text } from '../lib/messages';
import { categoryPath, productPath } from '../lib/urls';

export async function loader({ params }: LoaderFunctionArgs): Promise<StorefrontProduct> {
  try {
    return await storefront().products.get(params.slug ?? '');
  } catch (error) {
    if (isStorefrontError(error, 'NOT_FOUND')) throw data(null, { status: 404 });
    throw error;
  }
}

function variantFor(product: StorefrontProduct, chosen: Record<string, string>): StorefrontVariant | undefined {
  return product.variants.find((variant) => product.options.every((option) => variant.optionValues[option.name] === chosen[option.name]));
}

/** Add the chosen variant (by its option values) to the cart. */
export async function action({ request }: ActionFunctionArgs): Promise<ActionState> {
  const form = await request.formData();
  const quantity = wholeNumber(form, 'quantity', 1, 999);
  if (quantity === null) return { ok: false, message: text.quantityRange, fieldErrors: { quantity: text.quantityRange } };
  try {
    const product = await storefront().products.get(field(form, 'productId'));
    let item: CartItemInput = { productId: product.id, quantity };
    if (product.variants.length > 0) {
      const chosen = Object.fromEntries(product.options.map((option) => [option.name, field(form, `option:${option.name}`)]));
      const missing = product.options.find((option) => !chosen[option.name]);
      if (missing) return { ok: false, message: text.chooseOption(missing.name) };
      const variant = variantFor(product, chosen);
      if (!variant) return { ok: false, message: text.combinationUnavailable };
      if (!variant.available) return { ok: false, message: text.optionSoldOut };
      item = { variantId: variant.id, quantity };
    }
    const cart = await addToCart(item);
    return { ok: true, message: text.added(cart.itemCount) };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

/** The product's images; the featured image alone when it has no others. */
function galleryImages(product: StorefrontProduct): ProductImage[] {
  if (product.images.length > 0) return product.images;
  return product.featuredImageUrl ? [{ url: product.featuredImageUrl, altText: null }] : [];
}

function Gallery({ product }: Readonly<{ product: StorefrontProduct }>) {
  const images = galleryImages(product);
  const [active, setActive] = useState(0);
  const current = images[Math.min(active, images.length - 1)];
  if (!current) return <div className="aspect-square rounded-xl bg-surface-muted" />;
  return (
    <div className="flex flex-col gap-3">
      <div className="aspect-square overflow-hidden rounded-xl bg-surface-muted">
        {/* The product page's largest image: its likely LCP, so loaded first. */}
        <img src={current.url} alt={current.altText?.trim() || product.name} fetchPriority="high" className="size-full object-cover" />
      </div>
      {images.length > 1 ? (
        <ul role="list" aria-label={text.productImages} className="flex flex-wrap gap-2">
          {images.map((image, index) => (
            <li key={image.url}>
              <button type="button" aria-pressed={index === active} onClick={() => setActive(index)} className="block size-20 overflow-hidden rounded-lg border-2 border-transparent aria-pressed:border-ink">
                <img src={image.url} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
                <span className="sr-only">{text.showImage(index + 1)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Options({ product, chosen, onChoose }: Readonly<{ product: StorefrontProduct; chosen: Record<string, string>; onChoose: (name: string, value: string) => void }>) {
  const selectId = useId();
  return (
    <>
      {product.options.map((option) => {
        const name = `option:${option.name}`;
        const soldOut = (value: string) => !(variantFor(product, { ...chosen, [option.name]: value })?.available ?? false);
        // Up to five values as radio buttons (all visible at once); more in a select.
        if (option.values.length > 5) {
          return (
            <div key={option.name} className="field">
              <label htmlFor={`${selectId}-${option.name}`}>{option.name}</label>
              <select id={`${selectId}-${option.name}`} name={name} value={chosen[option.name] ?? ''} onChange={(event) => onChoose(option.name, event.target.value)} required>
                {option.values.map((value) => (
                  <option key={value} value={value}>
                    {soldOut(value) ? `${value} (${text.soldOut})` : value}
                  </option>
                ))}
              </select>
            </div>
          );
        }
        return (
          <fieldset key={option.name} className="flex flex-col gap-2">
            <legend className="label mb-1">{option.name}</legend>
            <div className="flex flex-wrap gap-2">
              {option.values.map((value) => (
                <label key={value} className="option-chip">
                  <input type="radio" name={name} value={value} checked={chosen[option.name] === value} onChange={() => onChoose(option.name, value)} required className="sr-only" />
                  <span className={soldOut(value) ? 'text-ink-muted line-through' : undefined}>{value}</span>
                  {soldOut(value) ? <span className="sr-only"> ({text.soldOut})</span> : null}
                </label>
              ))}
            </div>
          </fieldset>
        );
      })}
    </>
  );
}

function BuyForm({ product }: Readonly<{ product: StorefrontProduct }>) {
  const fetcher = useFetcher<ActionState>();
  const quantityId = useId();
  const [chosen, setChosen] = useState<Record<string, string>>(() => {
    const first = product.variants.find((variant) => variant.available) ?? product.variants[0];
    return first ? { ...first.optionValues } : {};
  });
  const variant = product.variants.length > 0 ? variantFor(product, chosen) : undefined;
  const available = product.variants.length > 0 ? (variant?.available ?? false) : product.available;
  const busy = fetcher.state !== 'idle';
  return (
    <fetcher.Form method="post" className="flex flex-col gap-5">
      <p className="text-2xl">
        <Price amount={variant?.price ?? product.price} compareAt={variant ? variant.compareAtPrice : product.compareAtPrice} currency={product.currency} />
      </p>
      <input type="hidden" name="productId" value={product.id} />
      <Options product={product} chosen={chosen} onChoose={(name, value) => setChosen((current) => ({ ...current, [name]: value }))} />
      <div className="flex flex-wrap items-end gap-3">
        <div className="field">
          <label htmlFor={quantityId}>{text.quantity}</label>
          <input id={quantityId} name="quantity" type="number" inputMode="numeric" min={1} max={999} step={1} defaultValue={1} required className="w-24" />
        </div>
        <SubmitButton busy={busy} busyText={text.adding} className="btn btn-primary min-w-48 flex-1">
          {available ? text.addToCart : text.soldOut}
        </SubmitButton>
      </div>
      <FormMessage state={fetcher.data} />
      {fetcher.data?.ok ? (
        <Link to="/cart" className="font-medium underline underline-offset-4">
          {text.viewCart}
        </Link>
      ) : null}
    </fetcher.Form>
  );
}

export function Component() {
  const product = useLoaderData() as StorefrontProduct;
  const category = product.categories[0];
  return (
    <div className="flex flex-col gap-6">
      <PageMeta title={product.name} description={product.description} path={productPath(product.slug)} />
      <nav aria-label={text.breadcrumb} className="text-sm">
        <ol className="flex flex-wrap gap-2">
          <li>
            <Link to="/" className="underline underline-offset-4">
              {text.home}
            </Link>{' '}
            <span aria-hidden="true">/</span>
          </li>
          {category ? (
            <li>
              <Link to={categoryPath(category.slug)} className="underline underline-offset-4">
                {category.name}
              </Link>{' '}
              <span aria-hidden="true">/</span>
            </li>
          ) : null}
          <li aria-current="page">{product.name}</li>
        </ol>
      </nav>
      <div className="grid gap-8 md:grid-cols-2 md:gap-12">
        <Gallery product={product} />
        <div className="flex flex-col gap-6">
          <h1 className="text-3xl font-semibold">{product.name}</h1>
          <BuyForm key={product.id} product={product} />
          {product.description ? (
            <section aria-labelledby="description" className="flex flex-col gap-2 border-t border-line pt-6">
              <h2 id="description" className="text-lg font-semibold">
                {text.description}
              </h2>
              {/* Plain text from the catalogue, never HTML. */}
              <p className="whitespace-pre-line">{product.description}</p>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
