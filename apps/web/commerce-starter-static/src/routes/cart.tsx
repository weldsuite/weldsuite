import { isStorefrontError, type Cart, type CartLine } from '@weldsuite/commerce-sdk';
import { Link, useFetcher, useLoaderData, type ActionFunctionArgs } from 'react-router';

import { Field, FormMessage, SubmitButton, type ActionState } from '../components/form-bits';
import { PageMeta } from '../components/page-meta';
import { Totals } from '../components/totals';
import { field, wholeNumber } from '../lib/cart';
import { config, storefront } from '../lib/client';
import { money } from '../lib/format';
import { describeError, discountReason, text } from '../lib/messages';
import { getCartToken } from '../lib/storage';
import { productPath } from '../lib/urls';
import { loadCart } from './root';

export async function loader(): Promise<Cart | null> {
  return loadCart();
}

/** Quantities (`set`), removing a line, applying or removing a discount code. */
export async function action({ request }: ActionFunctionArgs): Promise<ActionState> {
  const form = await request.formData();
  const token = getCartToken();
  if (!token) return { ok: false, message: describeError(null) };
  const cart = storefront().cart;
  try {
    switch (field(form, 'intent')) {
      case 'set': {
        const quantity = wholeNumber(form, 'set', 0, 999);
        if (quantity === null) return { ok: false, message: text.quantityRange };
        await cart.updateItem(token, field(form, 'lineId'), quantity);
        return { ok: true };
      }
      case 'remove':
        await cart.removeItem(token, field(form, 'lineId'));
        return { ok: true };
      case 'remove-discount':
        await cart.removeDiscount(token);
        return { ok: true };
      case 'discount': {
        const code = field(form, 'code');
        if (!code) return { ok: false, message: text.enterDiscount, fieldErrors: { code: text.enterDiscount } };
        const updated = await cart.applyDiscount(token, code);
        if (updated.discountProblem) {
          const message = discountReason(updated.discountProblem);
          return { ok: false, message, fieldErrors: { code: message } };
        }
        return { ok: true, message: text.discountApplied(updated.discount?.code ?? code) };
      }
      default:
        return { ok: false, message: describeError(null) };
    }
  } catch (error) {
    const message = isStorefrontError(error, 'DISCOUNT_NOT_APPLICABLE') ? discountReason(error.details?.reason) : describeError(error);
    return { ok: false, message, fieldErrors: field(form, 'intent') === 'discount' ? { code: message } : undefined };
  }
}

function LineControls({ line }: Readonly<{ line: CartLine }>) {
  const fetcher = useFetcher<ActionState>();
  const busy = fetcher.state !== 'idle';
  const name = line.variantName ? `${line.name} (${line.variantName})` : line.name;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <fetcher.Form method="post" className="flex items-center gap-1">
        <input type="hidden" name="intent" value="set" />
        <input type="hidden" name="lineId" value={line.id} />
        <button type="submit" name="set" value={String(Math.max(0, line.quantity - 1))} className="btn btn-secondary px-3" disabled={busy}>
          <span aria-hidden="true">−</span>
          <span className="sr-only">{text.oneFewer(name)}</span>
        </button>
        <output className="min-w-8 text-center tabular-nums" aria-live="polite">
          <span className="sr-only">{text.quantity}: </span>
          {line.quantity}
        </output>
        <button type="submit" name="set" value={String(Math.min(999, line.quantity + 1))} className="btn btn-secondary px-3" disabled={busy}>
          <span aria-hidden="true">+</span>
          <span className="sr-only">{text.oneMore(name)}</span>
        </button>
      </fetcher.Form>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="remove" />
        <input type="hidden" name="lineId" value={line.id} />
        <button type="submit" className="text-sm underline underline-offset-4" disabled={busy}>
          <span aria-hidden="true">{text.remove}</span>
          <span className="sr-only">{text.removeItem(name)}</span>
        </button>
      </fetcher.Form>
      {fetcher.data && !fetcher.data.ok ? <FormMessage state={fetcher.data} /> : null}
    </div>
  );
}

function DiscountForm({ cart }: Readonly<{ cart: Cart }>) {
  const fetcher = useFetcher<ActionState>();
  const busy = fetcher.state !== 'idle';
  if (cart.discount) {
    return (
      <fetcher.Form method="post" className="flex flex-col gap-1">
        <p>{text.discountApplied(cart.discount.code)}</p>
        <input type="hidden" name="intent" value="remove-discount" />
        <button type="submit" className="self-start text-sm underline underline-offset-4" disabled={busy}>
          {text.removeDiscount(cart.discount.code)}
        </button>
      </fetcher.Form>
    );
  }
  return (
    <fetcher.Form method="post" className="flex flex-col gap-2">
      <input type="hidden" name="intent" value="discount" />
      <div className="flex items-end gap-2">
        <Field name="code" label={text.discountCode} className="flex-1" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={100} error={fetcher.data?.fieldErrors?.code} />
        <SubmitButton busy={busy} busyText={text.saving} className="btn btn-secondary">
          {text.applyDiscount}
        </SubmitButton>
      </div>
      {fetcher.data?.ok ? <FormMessage state={fetcher.data} /> : null}
    </fetcher.Form>
  );
}

export function Component() {
  const cart = useLoaderData() as Cart | null;
  const locale = config?.locale ?? 'en-IE';
  return (
    <div className="flex flex-col gap-8">
      <PageMeta title={text.yourCart} />
      <meta name="robots" content="noindex" />
      <h1 className="text-3xl font-semibold">{text.yourCart}</h1>
      {!cart || cart.items.length === 0 ? (
        <div className="flex flex-col items-start gap-4">
          <p>{text.cartEmpty}</p>
          <Link to="/products" className="btn btn-primary">
            {text.continueShopping}
          </Link>
        </div>
      ) : (
        <div className="grid gap-10 lg:grid-cols-[1fr_22rem]">
          <ul role="list" aria-label={text.yourCart} className="border-t border-line">
            {cart.items.map((line) => (
              <li key={line.id} className="grid grid-cols-[5rem_1fr] gap-4 border-b border-line py-5 sm:grid-cols-[5rem_1fr_auto]">
                <div className="aspect-square overflow-hidden rounded-lg bg-surface-muted">
                  {line.imageUrl ? <img src={line.imageUrl} alt="" loading="lazy" decoding="async" className="size-full object-cover" /> : null}
                </div>
                <div className="flex flex-col gap-1">
                  <h2 className="font-medium">
                    <Link to={productPath(line.productId)} className="underline-offset-4 hover:underline">
                      {line.name}
                    </Link>
                  </h2>
                  {line.variantName ? <p className="hint">{line.variantName}</p> : null}
                  <p className="tabular-nums">{money(line.unitPrice, cart.currency, locale)}</p>
                  {line.problem ? <p className="font-medium text-danger">{text.lineProblems[line.problem]}</p> : null}
                  <LineControls line={line} />
                </div>
                <p className="col-start-2 font-semibold tabular-nums sm:col-start-3 sm:text-end">{money(line.total, cart.currency, locale)}</p>
              </li>
            ))}
          </ul>
          <aside aria-labelledby="summary" className="flex flex-col gap-5 self-start rounded-xl bg-surface-muted p-6">
            <h2 id="summary" className="text-xl font-semibold">
              {text.orderSummary}
            </h2>
            <Totals totals={cart} shippingKnown={Boolean(cart.shippingRate)} taxKnown={Boolean(cart.shippingAddress)} />
            <DiscountForm cart={cart} />
            {cart.items.some((line) => line.problem) ? <p className="font-medium text-danger">{text.fixCart}</p> : null}
            <Link to="/checkout" className="btn btn-primary w-full text-lg">
              {text.checkout}
            </Link>
          </aside>
        </div>
      )}
    </div>
  );
}
