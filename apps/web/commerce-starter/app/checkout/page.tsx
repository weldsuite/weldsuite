import {
  createIdempotencyKey,
  type Cart,
  type CartMissing,
  type PaymentMethod,
  type ShippingRateOffer,
  type ShopperCompany,
  type StorefrontChannel,
} from '@weldsuite/commerce-sdk';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { DetailsForm, PlaceOrderForm, ShippingForm } from '@/components/checkout-forms';
import { DiscountForm } from '@/components/discount-form';
import { Totals } from '@/components/totals';
import { requestOptions, shopLocale, storefront } from '@/lib/commerce';
import { activeCompany, getCart, getChannel, getSessionToken, getShopper } from '@/lib/data';
import { countryName, money } from '@/lib/format';
import { getCartToken } from '@/lib/session';

export const metadata: Metadata = { title: 'Checkout', robots: { index: false } };

const MISSING: Record<CartMissing, string> = {
  items: 'Items in your cart',
  email: 'Your email address',
  shippingAddress: 'A complete delivery address',
  shippingRate: 'A shipping method',
  billingAddress: 'A complete billing address',
};

function Step({ number, id, title, children }: { number: number; id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4 rounded-2xl border border-line p-5 sm:p-6">
      <h2 id={id} className="flex items-center gap-3 text-xl font-semibold">
        <span aria-hidden="true" className="inline-flex size-8 items-center justify-center rounded-full bg-brand text-brand-ink">
          {number}
        </span>
        <span>
          <span className="sr-only">Step {number}: </span>
          {title}
        </span>
      </h2>
      {children}
    </section>
  );
}

/** What stands between the shopper and the checkout (sign in, choose a company). */
function Gate({ text, href, label }: { text: string; href: string; label: string }) {
  return (
    <div className="flex max-w-xl flex-col items-start gap-4">
      <h1 className="text-3xl font-semibold">Checkout</h1>
      <p>{text}</p>
      <Link href={href} className="btn btn-primary">
        {label}
      </Link>
    </div>
  );
}

/** The shipping rates for the cart's delivery country (none until it has an address). */
async function loadRates(cart: Cart): Promise<ShippingRateOffer[]> {
  const token = await getCartToken();
  if (!cart.shippingAddress || !token) return [];
  return storefront().cart.shippingRates(token, { ...(await requestOptions()), shopperToken: await getSessionToken() });
}

/** Mollie, and pay on invoice for a B2B shopper buying for a company. */
function paymentMethods(channel: StorefrontChannel, company: ShopperCompany | null): PaymentMethod[] {
  const invoiceAllowed = channel.audience === 'b2b' && company !== null;
  return channel.paymentMethods.filter((m): m is PaymentMethod => m === 'mollie' || (m === 'invoice' && invoiceAllowed));
}

function CompanyNote({ company }: { company: ShopperCompany | null }) {
  if (!company) return null;
  return (
    <p>
      Buying for <strong>{company.name}</strong>.{' '}
      {company.spendLimit && company.currency ? (
        <>Orders above {money(company.spendLimit, company.currency, shopLocale)} need approval first.</>
      ) : null}
    </p>
  );
}

function ShippingStep({ cart, rates }: { cart: Cart; rates: ShippingRateOffer[] }) {
  if (!cart.shippingAddress) return <p className="text-ink-muted">Fill in your delivery address first.</p>;
  if (rates.length === 0) {
    return <p className="text-ink-muted">We have no shipping method for this address. Check the country.</p>;
  }
  return <ShippingForm rates={rates} selected={cart.shippingRate?.id ?? null} currency={cart.currency} locale={shopLocale} />;
}

function PaymentStep({ cart, methods }: { cart: Cart; methods: PaymentMethod[] }) {
  if (cart.items.some((line) => line.problem)) {
    return (
      <p className="text-danger">
        Some items can&apos;t be ordered. <Link href="/cart" className="underline">Fix your cart</Link> first.
      </p>
    );
  }
  if (!cart.ready) {
    return (
      <div className="flex flex-col gap-2">
        <p>Still needed before you can pay:</p>
        <ul className="list-disc pl-6">
          {cart.missing.map((item) => (
            <li key={item}>{MISSING[item] ?? item}</li>
          ))}
        </ul>
      </div>
    );
  }
  if (methods.length === 0) {
    return <p className="text-danger">There is no way to pay for this order right now. Contact the shop.</p>;
  }
  return (
    <PlaceOrderForm
      methods={methods}
      total={cart.total}
      currency={cart.currency}
      locale={shopLocale}
      idempotencyKey={createIdempotencyKey()}
    />
  );
}

function OrderSummary({ cart }: { cart: Cart }) {
  return (
    <aside aria-labelledby="order-summary" className="flex flex-col gap-5 self-start rounded-2xl bg-surface-muted p-6">
      <h2 id="order-summary" className="text-xl font-semibold">
        Your order
      </h2>
      <ul role="list" className="flex flex-col gap-3">
        {cart.items.map((line) => (
          <li key={line.id} className="flex justify-between gap-4">
            <span>
              {line.quantity} × {line.name}
              {line.variantName ? <span className="block text-sm text-ink-muted">{line.variantName}</span> : null}
            </span>
            <span className="tabular-nums">{money(line.total, cart.currency, shopLocale)}</span>
          </li>
        ))}
      </ul>
      <Totals totals={cart} locale={shopLocale} shippingKnown={Boolean(cart.shippingRate)} />
      {cart.viesUnavailable ? (
        <p className="hint">We could not check your VAT number with the EU just now, so VAT is charged. Try again later.</p>
      ) : null}
      {cart.discount ? (
        <p>
          Discount code <strong>{cart.discount.code}</strong> applied.
        </p>
      ) : (
        <DiscountForm />
      )}
      <Link href="/cart" className="text-sm font-medium underline underline-offset-4">
        Change your cart
      </Link>
    </aside>
  );
}

export default async function CheckoutPage() {
  const [cart, channel, shopper] = await Promise.all([getCart(), getChannel(), getShopper()]);
  if (!cart || cart.items.length === 0) redirect('/cart');

  const company = activeCompany(shopper);
  const b2b = channel.audience === 'b2b';

  if ((!channel.guestCheckout || b2b) && !shopper) {
    return (
      <Gate
        text="Sign in to check out. We email you a code; there is no password to remember."
        href="/account/sign-in?next=/checkout"
        label="Sign in to check out"
      />
    );
  }
  if (b2b && !company) {
    return <Gate text="Choose the company you are buying for first." href="/account" label="Choose a company" />;
  }

  const rates = await loadRates(cart);
  const countries = channel.sellingCountries
    .map((code) => ({ code, name: countryName(code, shopLocale) }))
    .sort((a, b) => a.name.localeCompare(b.name, shopLocale));

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-3xl font-semibold">Checkout</h1>
      <CompanyNote company={company} />

      <div className="grid gap-8 lg:grid-cols-[1fr_22rem]">
        <div className="flex flex-col gap-6">
          <Step number={1} id="details-heading" title="Your details">
            <DetailsForm
              b2b={b2b}
              countries={countries}
              defaults={{
                email: cart.email ?? shopper?.email ?? null,
                shippingAddress: cart.shippingAddress,
                billingAddress: cart.billingAddress,
                buyerVatNumber: cart.buyerVatNumber,
                customerReference: cart.customerReference,
                note: cart.note,
              }}
            />
          </Step>

          <Step number={2} id="shipping-heading" title="Shipping">
            <ShippingStep cart={cart} rates={rates} />
          </Step>

          <Step number={3} id="payment-heading" title="Review and pay">
            <PaymentStep cart={cart} methods={paymentMethods(channel, company)} />
          </Step>
        </div>

        <OrderSummary cart={cart} />
      </div>
    </div>
  );
}
