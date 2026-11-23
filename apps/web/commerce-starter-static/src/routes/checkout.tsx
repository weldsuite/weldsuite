import {
  createIdempotencyKey,
  isStorefrontError,
  type Address,
  type Cart,
  type CheckoutInput,
  type ShippingRateOffer,
  type StorefrontChannel,
  type UpdateCartInput,
} from '@weldsuite/commerce-sdk';
import { useId, useState, type ReactNode } from 'react';
import { Link, redirect, useFetcher, useLoaderData, type ActionFunctionArgs } from 'react-router';

import { Field, FormMessage, SubmitButton, type ActionState } from '../components/form-bits';
import { PageMeta } from '../components/page-meta';
import { Totals } from '../components/totals';
import { field } from '../lib/cart';
import { config, storefront } from '../lib/client';
import { countryName, money } from '../lib/format';
import { describeError, fieldErrors, messageForCode, MISSING, text } from '../lib/messages';
import { clearCartToken, getCartToken, setCheckoutState } from '../lib/storage';
import { orderUrlTemplate, paymentReturnUrl, returnPath } from '../lib/urls';
import { loadCart } from './root';

interface CheckoutData {
  cart: Cart;
  channel: StorefrontChannel;
  rates: ShippingRateOffer[];
}

export async function loader(): Promise<CheckoutData> {
  const cart = await loadCart();
  if (!cart || cart.items.length === 0) throw redirect('/cart');
  const token = getCartToken();
  const [channel, rates] = await Promise.all([
    storefront().channel.get(),
    cart.shippingAddress && token ? storefront().cart.shippingRates(token) : Promise.resolve([]),
  ]);
  return { cart, channel, rates };
}

const ADDRESS_FIELDS = ['name', 'company', 'line1', 'line2', 'postalCode', 'city', 'region', 'country', 'phone'] as const;
const REQUIRED: Array<(typeof ADDRESS_FIELDS)[number]> = ['name', 'line1', 'postalCode', 'city', 'country'];

function addressFrom(form: FormData, prefix: 'shippingAddress' | 'billingAddress'): Address {
  const address: Address = {};
  for (const name of ADDRESS_FIELDS) address[name] = field(form, `${prefix}.${name}`) || null;
  return address;
}

function missing(address: Address, prefix: string): Record<string, string> {
  return Object.fromEntries(REQUIRED.filter((name) => !address[name]).map((name) => [`${prefix}.${name}`, text.required]));
}

/** Whether a failed checkout may have placed the order (so the retry sends the same key). */
function outcomeUnknown(error: unknown): boolean {
  if (!isStorefrontError(error)) return true;
  return error.code === 'PROVIDER_ERROR' || error.code === 'NETWORK_ERROR' || error.status >= 500;
}

async function saveDetails(token: string, form: FormData): Promise<ActionState> {
  const email = field(form, 'email');
  const shippingAddress = addressFrom(form, 'shippingAddress');
  const billingAddress = form.get('billingSame') === 'on' ? null : addressFrom(form, 'billingAddress');
  const errors = { ...(email ? {} : { email: text.required }), ...missing(shippingAddress, 'shippingAddress'), ...(billingAddress ? missing(billingAddress, 'billingAddress') : {}) };
  if (Object.keys(errors).length > 0) return { ok: false, message: text.fillHighlighted, fieldErrors: errors };
  const input: UpdateCartInput = { email, shippingAddress, billingAddress, note: field(form, 'note') || null };
  const cart = await storefront().cart.update(token, input);
  return { ok: true, message: cart.shippingRate ? text.detailsSaved : text.detailsSavedNext };
}

async function placeOrder(token: string, form: FormData): Promise<ActionState | Response> {
  const shopUrl = config?.shopUrl ?? window.location.origin;
  const input: CheckoutInput = { paymentMethod: 'mollie', redirectUrl: paymentReturnUrl(shopUrl), expectedTotal: field(form, 'expectedTotal') || undefined };
  const orderUrl = orderUrlTemplate(shopUrl);
  if (orderUrl) input.orderUrl = orderUrl;
  const result = await storefront().cart.checkout(token, input, { idempotencyKey: field(form, 'idempotencyKey') || createIdempotencyKey() });
  clearCartToken();
  setCheckoutState({
    orderId: result.order.id,
    orderNumber: result.order.orderNumber,
    paymentMethod: 'mollie',
    paymentId: result.payment?.id ?? null,
    orderToken: result.orderToken,
  });
  // Off to Mollie; it sends the shopper back to /checkout/return?order=…&payment=….
  return redirect(result.payment?.checkoutUrl ?? returnPath(result.order.id, result.payment?.id ?? null));
}

export async function action({ request }: ActionFunctionArgs): Promise<ActionState | Response> {
  const form = await request.formData();
  const token = getCartToken();
  if (!token) return redirect('/cart');
  const intent = field(form, 'intent');
  try {
    if (intent === 'details') return await saveDetails(token, form);
    if (intent === 'shipping') {
      const rateId = field(form, 'shippingRateId');
      if (!rateId) return { ok: false, message: text.chooseShipping };
      await storefront().cart.setShippingRate(token, rateId);
      return { ok: true, message: text.shippingSaved };
    }
    return await placeOrder(token, form);
  } catch (error) {
    if (isStorefrontError(error, 'PRICE_CHANGED')) return { ok: false, message: text.priceChanged };
    return { ok: false, message: describeError(error), fieldErrors: fieldErrors(error), keepKey: intent === 'pay' && outcomeUnknown(error) };
  }
}

function Step({ number, title, children }: Readonly<{ number: number; title: string; children: ReactNode }>) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4 rounded-xl border border-line p-5 sm:p-6">
      <h2 id={id} className="flex items-center gap-3 text-xl font-semibold">
        <span aria-hidden="true" className="inline-flex size-8 items-center justify-center rounded-full bg-brand text-brand-ink">
          {number}
        </span>
        <span>
          <span className="sr-only">{text.step(number)}</span>
          {title}
        </span>
      </h2>
      {children}
    </section>
  );
}

/** One address, with the autocomplete tokens that let browsers fill it in (scoped shipping / billing). */
function AddressFields({ section, address, countries, errors, required }: Readonly<{ section: 'shipping' | 'billing'; address: Address | null; countries: string[]; errors: Record<string, string>; required: boolean }>) {
  const prefix = section === 'shipping' ? 'shippingAddress' : 'billingAddress';
  const countryId = useId();
  const locale = config?.locale ?? 'en-IE';
  const sorted = countries.map((code) => ({ code, name: countryName(code, locale) })).sort((a, b) => a.name.localeCompare(b.name, locale));
  const error = (name: string) => errors[`${prefix}.${name}`];
  const countryError = error('country');
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field className="sm:col-span-2" name={`${prefix}.name`} label={text.fullName} autoComplete={`${section} name`} defaultValue={address?.name ?? ''} required={required} maxLength={255} error={error('name')} />
      <Field className="sm:col-span-2" name={`${prefix}.company`} label={text.company} optional autoComplete={`${section} organization`} defaultValue={address?.company ?? ''} maxLength={255} />
      <Field className="sm:col-span-2" name={`${prefix}.line1`} label={text.line1} autoComplete={`${section} address-line1`} defaultValue={address?.line1 ?? ''} required={required} maxLength={255} error={error('line1')} />
      <Field className="sm:col-span-2" name={`${prefix}.line2`} label={text.line2} optional autoComplete={`${section} address-line2`} defaultValue={address?.line2 ?? ''} maxLength={255} />
      <Field name={`${prefix}.postalCode`} label={text.postalCode} autoComplete={`${section} postal-code`} defaultValue={address?.postalCode ?? ''} required={required} maxLength={30} autoCapitalize="characters" spellCheck={false} error={error('postalCode')} />
      <Field name={`${prefix}.city`} label={text.city} autoComplete={`${section} address-level2`} defaultValue={address?.city ?? ''} required={required} maxLength={120} error={error('city')} />
      <Field name={`${prefix}.region`} label={text.region} optional autoComplete={`${section} address-level1`} defaultValue={address?.region ?? ''} maxLength={120} />
      <div className="field">
        <label htmlFor={countryId}>{text.country}</label>
        <select
          id={countryId}
          name={`${prefix}.country`}
          autoComplete={`${section} country`}
          defaultValue={address?.country ?? (sorted.length === 1 ? sorted[0]?.code : '')}
          required={required}
          aria-invalid={countryError ? true : undefined}
          aria-describedby={countryError ? `${countryId}-error` : undefined}
        >
          {sorted.length > 1 ? <option value="">{text.chooseCountry}</option> : null}
          {sorted.map((country) => (
            <option key={country.code} value={country.code}>
              {country.name}
            </option>
          ))}
        </select>
        {countryError ? (
          <p id={`${countryId}-error`} className="field-error">
            {countryError}
          </p>
        ) : null}
      </div>
      <Field className="sm:col-span-2" name={`${prefix}.phone`} label={text.phone} optional type="tel" autoComplete={`${section} tel`} defaultValue={address?.phone ?? ''} maxLength={50} hint={section === 'shipping' ? text.phoneHint : undefined} />
    </div>
  );
}

function DetailsForm({ cart, channel }: Readonly<{ cart: Cart; channel: StorefrontChannel }>) {
  const fetcher = useFetcher<ActionState>();
  const noteId = useId();
  const errors = fetcher.data?.fieldErrors ?? {};
  const sameBilling = !cart.billingAddress || JSON.stringify(cart.billingAddress) === JSON.stringify(cart.shippingAddress);
  return (
    <fetcher.Form method="post" className="flex flex-col gap-6">
      <input type="hidden" name="intent" value="details" />
      <Field name="email" label={text.email} type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} maxLength={255} defaultValue={cart.email ?? ''} hint={text.emailHint} error={errors.email} />
      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 text-lg font-semibold">{text.deliveryAddress}</legend>
        <AddressFields section="shipping" address={cart.shippingAddress} countries={channel.sellingCountries} errors={errors} required />
      </fieldset>
      <div className="billing flex flex-col gap-4">
        <label className="flex items-center gap-3">
          <input type="checkbox" name="billingSame" className="billing-same" defaultChecked={sameBilling} />
          <span>{text.billingSame}</span>
        </label>
        <fieldset className="billing-fields flex flex-col gap-4">
          <legend className="mb-2 text-lg font-semibold">{text.billingAddress}</legend>
          {/* Checked on submit instead: hidden required fields would block the form. */}
          <AddressFields section="billing" address={cart.billingAddress} countries={channel.sellingCountries} errors={errors} required={false} />
        </fieldset>
      </div>
      <div className="field">
        <label htmlFor={noteId}>
          {text.note} <span className="hint font-normal">({text.optional})</span>
        </label>
        <textarea id={noteId} name="note" maxLength={1000} defaultValue={cart.note ?? ''} rows={3} />
      </div>
      <FormMessage state={fetcher.data} />
      <div>
        <SubmitButton busy={fetcher.state !== 'idle'} busyText={text.saving}>
          {text.saveDetails}
        </SubmitButton>
      </div>
    </fetcher.Form>
  );
}

function ShippingForm({ cart, rates }: Readonly<{ cart: Cart; rates: ShippingRateOffer[] }>) {
  const fetcher = useFetcher<ActionState>();
  const locale = config?.locale ?? 'en-IE';
  if (!cart.shippingAddress) return <p className="hint">{text.addressFirst}</p>;
  if (rates.length === 0) return <p>{text.noShipping}</p>;
  return (
    <fetcher.Form method="post" className="flex flex-col gap-4">
      <input type="hidden" name="intent" value="shipping" />
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">{text.shippingMethod}</legend>
        {rates.map((rate) => (
          <label key={rate.id} className="choice">
            <input type="radio" name="shippingRateId" value={rate.id} required defaultChecked={rate.id === cart.shippingRate?.id} />
            <span className="flex-1">{rate.name}</span>
            <span className="font-medium tabular-nums">{rate.free ? text.free : money(rate.price, cart.currency, locale)}</span>
          </label>
        ))}
      </fieldset>
      <FormMessage state={fetcher.data} />
      <div>
        <SubmitButton busy={fetcher.state !== 'idle'} busyText={text.saving} className="btn btn-secondary">
          {text.useShipping}
        </SubmitButton>
      </div>
    </fetcher.Form>
  );
}

function PaymentForm({ cart, channel }: Readonly<{ cart: Cart; channel: StorefrontChannel }>) {
  const fetcher = useFetcher<ActionState>();
  const [key, setKey] = useState(createIdempotencyKey);
  const [seen, setSeen] = useState<ActionState | undefined>(undefined);
  // A failed attempt whose outcome is known gets a fresh key; an unknown one retries with the same.
  if (fetcher.data !== seen) {
    setSeen(fetcher.data);
    if (fetcher.data && !fetcher.data.ok && !fetcher.data.keepKey) setKey(createIdempotencyKey());
  }
  if (cart.items.some((line) => line.problem)) {
    return (
      <p>
        {text.fixCart}{' '}
        <Link to="/cart" className="underline underline-offset-4">
          {text.changeCart}
        </Link>
      </p>
    );
  }
  if (!cart.ready) {
    return (
      <div className="flex flex-col gap-2">
        <p>{text.stillNeeded}</p>
        <ul className="list-disc pl-6">
          {cart.missing.map((item) => (
            <li key={item}>{MISSING[item] ?? item}</li>
          ))}
        </ul>
      </div>
    );
  }
  if (!channel.paymentMethods.includes('mollie')) return <p>{text.noPaymentMethod}</p>;
  const amount = money(cart.total, cart.currency, config?.locale ?? 'en-IE');
  return (
    <fetcher.Form method="post" className="flex flex-col gap-4">
      <input type="hidden" name="intent" value="pay" />
      <input type="hidden" name="idempotencyKey" value={key} />
      <input type="hidden" name="expectedTotal" value={cart.total} />
      <FormMessage state={fetcher.data} />
      <SubmitButton busy={fetcher.state !== 'idle'} busyText={text.placing} className="btn btn-primary w-full text-lg">
        {text.pay(amount)}
      </SubmitButton>
      <p className="hint">{text.mollieNote}</p>
    </fetcher.Form>
  );
}

export function Component() {
  const { cart, channel, rates } = useLoaderData() as CheckoutData;
  const locale = config?.locale ?? 'en-IE';
  return (
    <div className="flex flex-col gap-8">
      <PageMeta title={text.checkoutTitle} />
      <meta name="robots" content="noindex" />
      <h1 className="text-3xl font-semibold">{text.checkoutTitle}</h1>
      {!channel.guestCheckout ? (
        <p role="alert" className="notice notice-danger">
          {messageForCode('GUEST_CHECKOUT_DISABLED')}
        </p>
      ) : null}
      <div className="grid gap-8 lg:grid-cols-[1fr_22rem]">
        <div className="flex flex-col gap-6">
          <Step number={1} title={text.detailsStep}>
            <DetailsForm cart={cart} channel={channel} />
          </Step>
          <Step number={2} title={text.shippingStep}>
            <ShippingForm cart={cart} rates={rates} />
          </Step>
          <Step number={3} title={text.paymentStep}>
            <PaymentForm cart={cart} channel={channel} />
          </Step>
        </div>
        <aside aria-labelledby="your-order" className="flex flex-col gap-5 self-start rounded-xl bg-surface-muted p-6">
          <h2 id="your-order" className="text-xl font-semibold">
            {text.yourOrder}
          </h2>
          <ul role="list" className="flex flex-col gap-3">
            {cart.items.map((line) => (
              <li key={line.id} className="flex justify-between gap-4">
                <span>
                  {line.quantity} × {line.name}
                  {line.variantName ? <span className="block text-sm text-ink-muted">{line.variantName}</span> : null}
                </span>
                <span className="tabular-nums">{money(line.total, cart.currency, locale)}</span>
              </li>
            ))}
          </ul>
          <Totals totals={cart} shippingKnown={Boolean(cart.shippingRate)} taxKnown={Boolean(cart.shippingAddress)} />
          {cart.viesUnavailable ? <p className="hint">{text.viesUnavailable}</p> : null}
          {cart.discount ? <p>{text.discountApplied(cart.discount.code)}</p> : null}
          <Link to="/cart" className="text-sm font-medium underline underline-offset-4">
            {text.changeCart}
          </Link>
        </aside>
      </div>
    </div>
  );
}
