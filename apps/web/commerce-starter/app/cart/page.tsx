import type { Metadata } from 'next';
import Link from 'next/link';

import { DiscountForm } from '@/components/discount-form';
import { Price } from '@/components/price';
import { Totals } from '@/components/totals';
import { removeDiscountAction, removeLineAction, updateLineAction } from '@/lib/actions/cart';
import { shopLocale } from '@/lib/commerce';
import { getCart } from '@/lib/data';
import { discountReason, messageForCode } from '@/lib/errors';
import { money } from '@/lib/format';
import { single } from '@/lib/params';

export const metadata: Metadata = { title: 'Your cart' };

const LINE_PROBLEMS: Record<string, string> = {
  OUT_OF_STOCK: 'Not enough in stock. Lower the quantity or remove it.',
  NO_PRICE: 'No longer for sale. Remove it to check out.',
  INACTIVE: 'No longer available. Remove it to check out.',
};

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** The message for `?error=CODE` (set by the cart's form actions). */
function errorMessage(code: string | undefined): string | null {
  if (!code) return null;
  if (code === 'QUANTITY') return 'Enter a quantity from 0 to 999.';
  return messageForCode(code);
}

export default async function CartPage({ searchParams }: Props) {
  const [cart, params] = await Promise.all([getCart(), searchParams]);
  const error = errorMessage(single(params.error));

  if (!cart || cart.items.length === 0) {
    return (
      <div className="flex flex-col items-start gap-4">
        <h1 className="text-3xl font-semibold">Your cart</h1>
        <p>Your cart is empty.</p>
        <Link href="/products" className="btn btn-primary">
          Browse products
        </Link>
      </div>
    );
  }

  const blocked = cart.items.some((line) => line.problem);

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-3xl font-semibold">Your cart</h1>
      {error ? (
        <p role="alert" className="rounded-lg border border-danger bg-danger-soft px-4 py-3 text-danger">
          {error}
        </p>
      ) : null}

      <div className="grid gap-10 lg:grid-cols-[1fr_22rem]">
        <ul role="list" aria-label="Items in your cart" className="flex flex-col divide-y divide-line border-y border-line">
          {cart.items.map((line) => {
            const label = line.variantName ? `${line.name}, ${line.variantName}` : line.name;
            return (
              <li key={line.id} className="grid grid-cols-[5rem_1fr] gap-4 py-5 sm:grid-cols-[6rem_1fr_auto]">
                {line.imageUrl ? (
                  <img
                    src={line.imageUrl}
                    alt=""
                    width={96}
                    height={96}
                    loading="lazy"
                    className="aspect-square w-full rounded-lg bg-surface-muted object-cover"
                  />
                ) : (
                  <div aria-hidden="true" className="aspect-square w-full rounded-lg bg-surface-muted" />
                )}
                <div className="flex flex-col gap-2">
                  <h2 className="font-medium">{line.name}</h2>
                  {line.variantName ? <p className="text-sm text-ink-muted">{line.variantName}</p> : null}
                  <p className="text-sm">
                    <Price amount={line.unitPrice} currency={cart.currency} locale={shopLocale} /> each
                  </p>
                  {line.problem ? (
                    <p className="text-sm font-medium text-danger">{LINE_PROBLEMS[line.problem] ?? 'Not available.'}</p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-3">
                    {/* Three forms side by side, so Enter in the field submits the typed quantity, not "−". */}
                    <div className="flex flex-wrap items-center gap-1">
                      <form action={updateLineAction}>
                        <input type="hidden" name="lineId" value={line.id} />
                        <input type="hidden" name="set" value={String(Math.max(0, line.quantity - 1))} />
                        <button type="submit" className="btn btn-secondary w-11 px-0" aria-label={`One fewer ${label}`}>
                          −
                        </button>
                      </form>
                      <form id={`qty-form-${line.id}`} action={updateLineAction}>
                        <input type="hidden" name="lineId" value={line.id} />
                        <label htmlFor={`qty-${line.id}`} className="sr-only">
                          Quantity of {label}
                        </label>
                        <input
                          id={`qty-${line.id}`}
                          name="quantity"
                          type="number"
                          inputMode="numeric"
                          min={0}
                          max={999}
                          step={1}
                          defaultValue={line.quantity}
                          className="w-16 text-center"
                        />
                      </form>
                      <form action={updateLineAction}>
                        <input type="hidden" name="lineId" value={line.id} />
                        <input type="hidden" name="set" value={String(Math.min(999, line.quantity + 1))} />
                        <button type="submit" className="btn btn-secondary w-11 px-0" aria-label={`One more ${label}`}>
                          +
                        </button>
                      </form>
                      {/* Belongs to the quantity form (form attribute), shown after the stepper. */}
                      <button type="submit" form={`qty-form-${line.id}`} className="btn btn-secondary ml-1">
                        Update<span className="sr-only"> quantity of {label}</span>
                      </button>
                    </div>
                    <form action={removeLineAction}>
                      <input type="hidden" name="lineId" value={line.id} />
                      <button type="submit" className="text-sm font-medium text-danger underline underline-offset-4">
                        Remove<span className="sr-only"> {label}</span>
                      </button>
                    </form>
                  </div>
                </div>
                <p className="col-start-2 font-semibold tabular-nums sm:col-start-3 sm:text-right">
                  <span className="sr-only">Line total: </span>
                  {money(line.total, cart.currency, shopLocale)}
                </p>
              </li>
            );
          })}
        </ul>

        <aside aria-labelledby="summary" className="flex flex-col gap-6 self-start rounded-2xl bg-surface-muted p-6">
          <h2 id="summary" className="text-xl font-semibold">
            Summary
          </h2>
          <Totals totals={cart} locale={shopLocale} shippingKnown={Boolean(cart.shippingRate)} />
          {cart.discount ? (
            <div className="flex flex-col gap-1">
              <p>
                Discount code <strong>{cart.discount.code}</strong> applied.
              </p>
              {cart.discountProblem ? <p className="text-sm text-danger">{discountReason(cart.discountProblem)}</p> : null}
              <form action={removeDiscountAction}>
                <button type="submit" className="text-sm font-medium underline underline-offset-4">
                  Remove discount code
                </button>
              </form>
            </div>
          ) : (
            <DiscountForm />
          )}
          {blocked ? (
            <p className="text-sm font-medium text-danger">Fix the items marked above to check out.</p>
          ) : (
            <Link href="/checkout" className="btn btn-primary w-full">
              Check out
            </Link>
          )}
        </aside>
      </div>
    </div>
  );
}
