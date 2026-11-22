'use client';

import type { StorefrontProduct } from '@weldsuite/commerce-sdk';
import Link from 'next/link';
import { useActionState, useId, useMemo, useState } from 'react';

import { addItemAction } from '@/lib/actions/cart';
import { idle } from '@/lib/actions/state';

import { FormMessage, PendingButton, submitKeepingValues } from './form-bits';
import { Price } from './price';

/**
 * The variant picker and "Add to cart". The form sends the chosen option
 * values (not a variant id), so it works before JavaScript loads too: the
 * server finds the variant. Script only updates the price and stock shown.
 */
export function AddToCartForm({ product, locale }: Readonly<{ product: StorefrontProduct; locale: string }>) {
  const [state, action, pending] = useActionState(addItemAction, idle);
  const firstAvailable = product.variants.find((v) => v.available) ?? product.variants[0];
  const [selected, setSelected] = useState<Record<string, string>>(() => ({ ...firstAvailable?.optionValues }));
  const id = useId();

  const variant = useMemo(
    () =>
      product.variants.find((v) => product.options.every((option) => v.optionValues[option.name] === selected[option.name])),
    [product, selected],
  );
  const hasVariants = product.variants.length > 0;
  const price = hasVariants ? variant?.price : product.price;
  const compareAt = hasVariants ? variant?.compareAtPrice : product.compareAtPrice;
  const available = hasVariants ? Boolean(variant?.available) : product.available;

  /** Whether choosing `value` for `option` (keeping the other choices) gives a variant in stock. */
  const valueAvailable = (option: string, value: string) =>
    product.variants.some(
      (v) =>
        v.available &&
        v.optionValues[option] === value &&
        product.options.every((o) => o.name === option || v.optionValues[o.name] === selected[o.name]),
    );

  return (
    <form action={action} onSubmit={submitKeepingValues(action)} className="flex flex-col gap-5">
      <input type="hidden" name="productId" value={product.id} />

      <p className="text-2xl" aria-live="polite">
        {price ? (
          <Price amount={price} compareAt={compareAt} currency={product.currency} locale={locale} />
        ) : (
          <span className="text-ink-muted">Not available in this combination</span>
        )}
      </p>

      {product.options.map((option) => {
        const name = `option:${option.name}`;
        // Up to five values as radio buttons (all visible at once); more as a select.
        if (option.values.length > 5) {
          return (
            <div key={option.name} className="field">
              <label htmlFor={`${id}-${option.name}`}>{option.name}</label>
              <select
                id={`${id}-${option.name}`}
                name={name}
                required
                value={selected[option.name] ?? ''}
                onChange={(event) => setSelected((s) => ({ ...s, [option.name]: event.target.value }))}
              >
                {option.values.map((value) => (
                  <option key={value} value={value}>
                    {value}
                    {valueAvailable(option.name, value) ? '' : ' (sold out)'}
                  </option>
                ))}
              </select>
            </div>
          );
        }
        return (
          <fieldset key={option.name} className="flex flex-col gap-2">
            <legend className="label mb-2">{option.name}</legend>
            <div className="flex flex-wrap gap-2">
              {option.values.map((value) => {
                const inStock = valueAvailable(option.name, value);
                return (
                  <label
                    key={value}
                    className="relative flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border-2 border-line px-3 py-2 has-checked:border-brand has-checked:bg-brand-soft has-focus-visible:outline-3 has-focus-visible:outline-brand"
                  >
                    <input
                      type="radio"
                      name={name}
                      value={value}
                      required
                      checked={selected[option.name] === value}
                      onChange={() => setSelected((s) => ({ ...s, [option.name]: value }))}
                      className="focus-visible:outline-none"
                    />
                    <span>{value}</span>
                    {inStock ? null : <span className="text-sm text-ink-muted">(sold out)</span>}
                  </label>
                );
              })}
            </div>
          </fieldset>
        );
      })}

      <div className="flex flex-wrap items-end gap-3">
        <div className="field w-28">
          <label htmlFor={`${id}-quantity`}>Quantity</label>
          <input
            id={`${id}-quantity`}
            name="quantity"
            type="number"
            inputMode="numeric"
            min={1}
            max={999}
            step={1}
            defaultValue={1}
            required
          />
        </div>
        {available ? (
          <PendingButton pending={pending} pendingText="Adding…">
            Add to cart
          </PendingButton>
        ) : (
          <p className="flex min-h-11 items-center font-medium text-danger">Sold out</p>
        )}
      </div>

      <FormMessage state={state} />
      {state.status === 'success' ? (
        <p>
          <Link href="/cart" className="font-medium text-brand underline underline-offset-4">
            View your cart
          </Link>
        </p>
      ) : null}
    </form>
  );
}
