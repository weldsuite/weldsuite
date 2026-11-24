import type { StorefrontProduct, StorefrontVariant } from '@weldsuite/commerce-sdk';
import { useId, useState } from 'react';
import { useShop } from '../context';
import { format } from '../strings';
import { Price, VatNote } from './price';

/** The variant the chosen option values make, if any. */
export function variantFor(product: StorefrontProduct, chosen: Record<string, string>): StorefrontVariant | null {
  if (product.variants.length === 0) return null;
  return product.variants.find((variant) => product.options.every((option) => variant.optionValues[option.name] === chosen[option.name])) ?? null;
}

/** The first available variant's values, so the page opens on something that can be bought. */
function initialChoice(product: StorefrontProduct): Record<string, string> {
  const variant = product.variants.find((v) => v.available) ?? product.variants[0];
  if (variant) return { ...variant.optionValues };
  return Object.fromEntries(product.options.map((option) => [option.name, option.values[0] ?? '']));
}

/** Whether choosing `value` for `option` (keeping the rest) gives an available variant. */
function valueAvailable(product: StorefrontProduct, chosen: Record<string, string>, option: string, value: string): boolean {
  const variant = variantFor(product, { ...chosen, [option]: value });
  return variant?.available ?? false;
}

function OptionField({
  product,
  option,
  chosen,
  onChange,
}: Readonly<{
  product: StorefrontProduct;
  option: StorefrontProduct['options'][number];
  chosen: Record<string, string>;
  onChange: (value: string) => void;
}>) {
  const { shop } = useShop();
  const id = useId();
  const name = `option:${option.name}`;
  const soldOut = shop.strings.product.soldOut;
  // Up to five choices as radio buttons (all visible); more in a select.
  if (option.values.length > 5) {
    return (
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="shop-label">
          {option.name}
        </label>
        <select id={id} name={name} className="shop-input" value={chosen[option.name] ?? ''} required onChange={(event) => onChange(event.target.value)}>
          {option.values.map((value) => (
            <option key={value} value={value}>
              {valueAvailable(product, chosen, option.name, value) ? value : `${value} (${soldOut})`}
            </option>
          ))}
        </select>
      </div>
    );
  }
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="shop-label mb-1.5">{option.name}</legend>
      <div className="flex flex-wrap gap-2">
        {option.values.map((value) => {
          const available = valueAvailable(product, chosen, option.name, value);
          return (
            <label
              key={value}
              className="relative inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-shop border border-shop-border px-4 has-checked:border-shop-fg has-checked:ring-2 has-checked:ring-shop-fg has-focus-visible:outline-3 has-focus-visible:outline-offset-2 has-focus-visible:outline-shop-accent"
            >
              <input
                type="radio"
                name={name}
                value={value}
                checked={chosen[option.name] === value}
                onChange={() => onChange(value)}
                required
                className="sr-only"
              />
              <span className={available ? undefined : 'text-shop-subtle line-through'}>{value}</span>
              {available ? null : <span className="sr-only">{` (${soldOut})`}</span>}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/**
 * The fields of a product's buy form: options, quantity and the button. The
 * renderer wraps them in its form (fields named `productId`, `option:<name>`
 * and `quantity`), so the theme decides how they look and the renderer what
 * happens.
 */
export function ProductBuyFields({
  product,
  pending = false,
  showSku = false,
}: Readonly<{ product: StorefrontProduct; pending?: boolean; showSku?: boolean }>) {
  const { shop } = useShop();
  const s = shop.strings.product;
  const quantityId = useId();
  const [chosen, setChosen] = useState<Record<string, string>>(() => initialChoice(product));
  const variant = variantFor(product, chosen);
  const hasVariants = product.variants.length > 0;
  const available = hasVariants ? (variant?.available ?? false) : product.available;
  const price = variant?.price ?? product.price;
  const compareAt = variant ? variant.compareAtPrice : product.compareAtPrice;
  let buttonLabel = s.addToCart;
  if (!available) buttonLabel = s.soldOut;
  else if (pending) buttonLabel = s.adding;
  return (
    <div className="flex flex-col gap-5">
      <p className="flex flex-wrap items-baseline gap-x-2 text-2xl">
        <Price amount={price} compareAt={compareAt} currency={product.currency} />
        <VatNote />
      </p>
      <input type="hidden" name="productId" value={product.id} />
      {hasVariants
        ? product.options.map((option) => (
            <OptionField
              key={option.name}
              product={product}
              option={option}
              chosen={chosen}
              onChange={(value) => setChosen((current) => ({ ...current, [option.name]: value }))}
            />
          ))
        : null}
      {hasVariants && !variant ? <p className="shop-hint">{shop.strings.errors.local.COMBINATION_UNAVAILABLE}</p> : null}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={quantityId} className="shop-label">
            {s.quantity}
          </label>
          <input
            id={quantityId}
            name="quantity"
            type="number"
            inputMode="numeric"
            min={1}
            max={999}
            step={1}
            defaultValue={1}
            required
            className="shop-input w-24"
          />
        </div>
        <button type="submit" className="shop-btn shop-btn-primary min-w-48 flex-1" disabled={pending || !available} aria-disabled={pending || !available}>
          {buttonLabel}
        </button>
      </div>
      {showSku && variant?.sku ? <p className="shop-hint">{format(s.sku, { sku: variant.sku })}</p> : null}
    </div>
  );
}
