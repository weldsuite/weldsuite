'use client';

import type { Address, PaymentMethod, ShippingRateOffer } from '@weldsuite/commerce-sdk';
import { useActionState, useId, useState } from 'react';

import {
  chooseShippingAction,
  placeOrderAction,
  saveDetailsAction,
  type PlaceOrderState,
} from '@/lib/actions/checkout';
import { idle } from '@/lib/actions/state';
import { money } from '@/lib/format';

import { Field, FormMessage, PendingButton, SubmitButton, submitKeepingValues, useFormFocus } from './form-bits';

type Section = 'shipping' | 'billing';

/**
 * One address, with the autocomplete tokens that let browsers fill it in
 * (scoped with "shipping" / "billing" so both can be autofilled).
 */
function AddressFields({
  section,
  address,
  countries,
  errors,
  required,
}: Readonly<{
  section: Section;
  address: Address | null;
  countries: Array<{ code: string; name: string }>;
  errors: Record<string, string>;
  /** Billing fields are checked on the server: they may be hidden. */
  required: boolean;
}>) {
  const prefix = section === 'shipping' ? 'shippingAddress' : 'billingAddress';
  const countryId = useId();
  const error = (field: string) => errors[`${prefix}.${field}`];
  const countryError = error('country');
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field
        className="sm:col-span-2"
        name={`${prefix}.name`}
        label="Full name"
        autoComplete={`${section} name`}
        defaultValue={address?.name ?? ''}
        required={required}
        maxLength={255}
        error={error('name')}
      />
      <Field
        className="sm:col-span-2"
        name={`${prefix}.company`}
        label="Company"
        optional
        autoComplete={`${section} organization`}
        defaultValue={address?.company ?? ''}
        maxLength={255}
        error={error('company')}
      />
      <Field
        className="sm:col-span-2"
        name={`${prefix}.line1`}
        label="Street and house number"
        autoComplete={`${section} address-line1`}
        defaultValue={address?.line1 ?? ''}
        required={required}
        maxLength={255}
        error={error('line1')}
      />
      <Field
        className="sm:col-span-2"
        name={`${prefix}.line2`}
        label="Address line 2"
        optional
        autoComplete={`${section} address-line2`}
        defaultValue={address?.line2 ?? ''}
        maxLength={255}
        error={error('line2')}
      />
      <Field
        name={`${prefix}.postalCode`}
        label="Postal code"
        autoComplete={`${section} postal-code`}
        defaultValue={address?.postalCode ?? ''}
        required={required}
        maxLength={30}
        autoCapitalize="characters"
        spellCheck={false}
        error={error('postalCode')}
      />
      <Field
        name={`${prefix}.city`}
        label="City"
        autoComplete={`${section} address-level2`}
        defaultValue={address?.city ?? ''}
        required={required}
        maxLength={120}
        error={error('city')}
      />
      <Field
        name={`${prefix}.region`}
        label="State or province"
        optional
        autoComplete={`${section} address-level1`}
        defaultValue={address?.region ?? ''}
        maxLength={120}
        error={error('region')}
      />
      <div className="field">
        <label htmlFor={countryId}>Country</label>
        <select
          id={countryId}
          name={`${prefix}.country`}
          autoComplete={`${section} country`}
          defaultValue={address?.country ?? (countries.length === 1 ? countries[0]?.code : '')}
          required={required}
          aria-invalid={countryError ? true : undefined}
          aria-describedby={countryError ? `${countryId}-error` : undefined}
        >
          {countries.length > 1 ? <option value="">Choose a country</option> : null}
          {countries.map((country) => (
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
      <Field
        className="sm:col-span-2"
        name={`${prefix}.phone`}
        label="Phone"
        optional
        type="tel"
        autoComplete={`${section} tel`}
        defaultValue={address?.phone ?? ''}
        maxLength={50}
        hint="For the delivery company, if they need to reach you."
        error={error('phone')}
      />
    </div>
  );
}

export interface DetailsDefaults {
  email: string | null;
  shippingAddress: Address | null;
  billingAddress: Address | null;
  buyerVatNumber: string | null;
  customerReference: string | null;
  note: string | null;
}

/** Step 1: contact details, delivery and billing addresses (and the B2B fields). */
export function DetailsForm({
  defaults,
  countries,
  b2b,
}: Readonly<{
  defaults: DetailsDefaults;
  countries: Array<{ code: string; name: string }>;
  b2b: boolean;
}>) {
  const [state, action, pending] = useActionState(saveDetailsAction, idle);
  const form = useFormFocus(state);
  const errors = state.fieldErrors ?? {};
  const noteId = useId();
  const sameBilling =
    !defaults.billingAddress || JSON.stringify(defaults.billingAddress) === JSON.stringify(defaults.shippingAddress);
  return (
    <form
      ref={form}
      action={action}
      onSubmit={submitKeepingValues(action)}
      className="flex flex-col gap-6"
      aria-labelledby="details-heading"
    >
      <Field
        name="email"
        label="Email"
        type="email"
        autoComplete="email"
        spellCheck={false}
        required
        maxLength={255}
        defaultValue={defaults.email ?? ''}
        hint="For the order confirmation."
        error={errors.email}
      />

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 text-lg font-semibold">Delivery address</legend>
        <AddressFields section="shipping" address={defaults.shippingAddress} countries={countries} errors={errors} required />
      </fieldset>

      <div className="billing flex flex-col gap-4">
        <label className="flex items-center gap-3">
          <input type="checkbox" name="billingSame" className="billing-same" defaultChecked={sameBilling} />
          <span>Billing address is the same as the delivery address</span>
        </label>
        <fieldset className="billing-fields flex flex-col gap-4">
          <legend className="mb-2 text-lg font-semibold">Billing address</legend>
          <AddressFields section="billing" address={defaults.billingAddress} countries={countries} errors={errors} required={false} />
        </fieldset>
      </div>

      {b2b ? (
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-2 text-lg font-semibold">For your company</legend>
          <Field
            name="buyerVatNumber"
            label="VAT number"
            optional
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={50}
            defaultValue={defaults.buyerVatNumber ?? ''}
            hint="EU businesses: no VAT is charged across borders (reverse charge)."
            error={errors.buyerVatNumber}
          />
          <Field
            name="customerReference"
            label="Your reference or PO number"
            optional
            autoComplete="off"
            maxLength={100}
            defaultValue={defaults.customerReference ?? ''}
            error={errors.customerReference}
          />
        </fieldset>
      ) : null}

      <div className="field">
        <label htmlFor={noteId}>
          Note <span className="hint font-normal">(optional)</span>
        </label>
        <textarea id={noteId} name="note" maxLength={1000} defaultValue={defaults.note ?? ''} rows={3} />
      </div>

      <FormMessage state={state} />
      <div>
        <PendingButton pending={pending} pendingText="Saving…">
          Save and continue to shipping
        </PendingButton>
      </div>
    </form>
  );
}

/** Step 2: the shipping method. */
export function ShippingForm({
  rates,
  selected,
  currency,
  locale,
}: Readonly<{
  rates: ShippingRateOffer[];
  selected: string | null;
  currency: string;
  locale: string;
}>) {
  const [state, action] = useActionState(chooseShippingAction, idle);
  return (
    <form action={action} className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Shipping method</legend>
        {rates.map((rate) => (
          <label
            key={rate.id}
            className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border-2 border-line px-4 py-3 has-checked:border-brand has-checked:bg-brand-soft"
          >
            <input type="radio" name="shippingRateId" value={rate.id} required defaultChecked={rate.id === selected} />
            <span className="flex-1">{rate.name}</span>
            <span className="font-medium tabular-nums">{rate.free ? 'Free' : money(rate.price, currency, locale)}</span>
          </label>
        ))}
      </fieldset>
      <FormMessage state={state} />
      <div>
        <SubmitButton className="btn btn-secondary" pendingText="Saving…">
          Use this shipping method
        </SubmitButton>
      </div>
    </form>
  );
}

const METHOD_LABELS: Record<PaymentMethod, { title: string; text: string }> = {
  mollie: { title: 'Pay online', text: 'iDEAL, card, Bancontact and more, through Mollie.' },
  invoice: { title: 'Pay on invoice', text: "We send an invoice with your company's payment terms." },
};

/** Step 3: payment method and "Pay". */
export function PlaceOrderForm({
  methods,
  total,
  currency,
  locale,
  idempotencyKey,
}: Readonly<{
  methods: PaymentMethod[];
  total: string;
  currency: string;
  locale: string;
  idempotencyKey: string;
}>) {
  const [state, action, pending] = useActionState<PlaceOrderState, FormData>(placeOrderAction, { status: 'idle' });
  const [method, setMethod] = useState<PaymentMethod | undefined>(methods[0]);
  const amount = money(total, currency, locale);
  return (
    <form action={action} onSubmit={submitKeepingValues(action)} className="flex flex-col gap-4">
      <input type="hidden" name="idempotencyKey" value={state.idempotencyKey ?? idempotencyKey} />
      <input type="hidden" name="expectedTotal" value={total} />
      <fieldset className="flex flex-col gap-2">
        <legend className="label mb-2">Payment method</legend>
        {methods.map((m) => (
          <label
            key={m}
            className="grid cursor-pointer grid-cols-[auto_1fr] items-start gap-x-3 rounded-lg border-2 border-line px-4 py-3 has-checked:border-brand has-checked:bg-brand-soft"
          >
            <input
              type="radio"
              name="paymentMethod"
              value={m}
              required
              checked={method === m}
              onChange={() => setMethod(m)}
              className="row-span-2 mt-1"
            />
            <span className="font-medium">{METHOD_LABELS[m].title}</span>
            <span className="hint">{METHOD_LABELS[m].text}</span>
          </label>
        ))}
      </fieldset>
      <FormMessage state={state} />
      <PendingButton pending={pending} className="btn btn-primary w-full text-lg" pendingText="Placing your order…">
        {method === 'invoice' ? `Place order for ${amount}` : `Pay ${amount}`}
      </PendingButton>
      <p className="hint">
        {method === 'mollie'
          ? 'You will be taken to Mollie to pay, then come back here.'
          : 'Your order is placed straight away.'}
      </p>
    </form>
  );
}
