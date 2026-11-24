import type { Cart, PaymentMethod, ShippingRateOffer } from '@weldsuite/commerce-sdk'
import { format, ShopLink, Totals, useMoney, useShop } from '@weldsuite/storefront-theme'
import { useId, useState, type ReactNode } from 'react'
import { chooseShipping, placeOrder, saveDetails } from '@/lib/server/actions/checkout'
import type { CheckoutView } from '@/lib/server/loaders/checkout'
import { Field, FormMessage, ShopForm, SubmitButton } from '../shop-form'
import { QueryError } from '../template-view'
import { AddressFields } from './address-fields'

function Step({ number, title, children }: Readonly<{ number: number; title: string; children: ReactNode }>) {
  const { shop } = useShop()
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4 rounded-shop border border-shop-border p-5 sm:p-6">
      <h2 id={id} className="flex items-center gap-3 text-xl font-semibold">
        <span aria-hidden="true" className="inline-flex size-8 items-center justify-center rounded-full bg-shop-primary text-shop-on-primary">
          {number}
        </span>
        <span>
          <span className="sr-only">{format(shop.strings.checkout.step, { number })} </span>
          {title}
        </span>
      </h2>
      {children}
    </section>
  )
}

function DetailsForm({ view }: Readonly<{ view: CheckoutView }>) {
  const { shop } = useShop()
  const s = shop.strings.checkout
  const noteId = useId()
  const { cart } = view
  const sameBilling = !cart.billingAddress || JSON.stringify(cart.billingAddress) === JSON.stringify(cart.shippingAddress)
  return (
    <ShopForm action={saveDetails} back="/checkout" className="flex flex-col gap-6">
      <Field name="email" label={s.email} type="email" autoComplete="email" spellCheck={false} autoCapitalize="none" maxLength={255} defaultValue={view.email ?? ''} hint={s.emailHint} />
      <fieldset className="flex flex-col gap-4">
        <legend className="mb-2 text-lg font-semibold">{s.deliveryAddress}</legend>
        <AddressFields section="shipping" address={cart.shippingAddress} countries={view.countries} required />
      </fieldset>
      <div className="group flex flex-col gap-4">
        <label className="flex items-center gap-3">
          <input type="checkbox" name="billingSame" className="billing-same size-5" defaultChecked={sameBilling} />
          <span>{s.billingSame}</span>
        </label>
        <fieldset className="flex flex-col gap-4 group-has-[.billing-same:checked]:hidden">
          <legend className="mb-2 text-lg font-semibold">{s.billingAddress}</legend>
          <AddressFields section="billing" address={cart.billingAddress} countries={view.countries} required={false} />
        </fieldset>
      </div>
      {view.b2b ? (
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-2 text-lg font-semibold">{s.forCompany}</legend>
          <Field name="buyerVatNumber" label={s.vatNumber} optional autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={50} defaultValue={cart.buyerVatNumber ?? ''} hint={s.vatNumberHint} />
          <Field name="customerReference" label={s.reference} optional autoComplete="off" maxLength={100} defaultValue={cart.customerReference ?? ''} />
        </fieldset>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={noteId} className="shop-label">
          {s.note} <span className="shop-hint font-normal">({shop.strings.common.optional})</span>
        </label>
        <textarea id={noteId} name="note" maxLength={1000} defaultValue={cart.note ?? ''} rows={3} className="shop-input" />
      </div>
      <FormMessage />
      <div>
        <SubmitButton pendingText={shop.strings.common.saving}>{s.saveDetails}</SubmitButton>
      </div>
    </ShopForm>
  )
}

function ShippingForm({ cart, rates }: Readonly<{ cart: Cart; rates: ShippingRateOffer[] }>) {
  const { shop } = useShop()
  const money = useMoney()
  const s = shop.strings.checkout
  if (!cart.shippingAddress) return <p className="shop-hint">{s.addressFirst}</p>
  if (rates.length === 0) return <p>{s.noShipping}</p>
  return (
    <ShopForm action={chooseShipping} back="/checkout" className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">{s.shippingMethod}</legend>
        {rates.map((rate) => (
          <label key={rate.id} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-shop border-2 border-shop-border px-4 py-3 has-checked:border-shop-fg">
            <input type="radio" name="shippingRateId" value={rate.id} required defaultChecked={rate.id === cart.shippingRate?.id} className="size-5" />
            <span className="flex-1">{rate.name}</span>
            <span className="font-medium tabular-nums">{rate.free ? s.free : money(rate.price, cart.currency)}</span>
          </label>
        ))}
      </fieldset>
      <FormMessage />
      <div>
        <SubmitButton className="shop-btn shop-btn-secondary" pendingText={shop.strings.common.saving}>
          {s.useShipping}
        </SubmitButton>
      </div>
    </ShopForm>
  )
}

function Terms() {
  const { shop } = useShop()
  const s = shop.strings.checkout
  const terms = shop.legalPaths.terms
  const [before, after] = s.terms.split('{terms}')
  return (
    <label className="flex items-start gap-3">
      <input type="checkbox" name="terms" required className="mt-1 size-5 shrink-0" />
      <span>
        {terms ? (
          <>
            {before}
            <ShopLink href={terms} className="underline underline-offset-4" target="_blank">
              {s.termsLink}
            </ShopLink>
            {after}
          </>
        ) : (
          s.termsPlain
        )}
      </span>
    </label>
  )
}

function PaymentForm({ view }: Readonly<{ view: CheckoutView }>) {
  const { shop } = useShop()
  const money = useMoney()
  const s = shop.strings.checkout
  const { cart, methods } = view
  const [method, setMethod] = useState<PaymentMethod | undefined>(methods[0])
  const [key, setKey] = useState(view.idempotencyKey)
  if (cart.items.some((line) => line.problem)) {
    return (
      <p>
        {s.fixCart}{' '}
        <ShopLink href="/cart" className="underline underline-offset-4">
          {s.changeCart}
        </ShopLink>
      </p>
    )
  }
  if (!cart.ready) {
    return (
      <div className="flex flex-col gap-2">
        <p>{s.stillNeeded}</p>
        <ul className="list-disc ps-6">
          {cart.missing.map((item) => (
            <li key={item}>{s.missing[item]}</li>
          ))}
        </ul>
      </div>
    )
  }
  if (methods.length === 0) return <p>{s.noPaymentMethod}</p>
  const amount = money(cart.total, cart.currency)
  return (
    <ShopForm action={placeOrder} back="/checkout" className="flex flex-col gap-5" onResult={(result) => !result.ok && result.idempotencyKey && setKey(result.idempotencyKey)}>
      <input type="hidden" name="idempotencyKey" value={key} />
      <input type="hidden" name="expectedTotal" value={cart.total} />
      <fieldset className="flex flex-col gap-2">
        <legend className="shop-label mb-2">{s.paymentMethod}</legend>
        {methods.map((m) => (
          <label key={m} className="grid cursor-pointer grid-cols-[auto_1fr] items-start gap-x-3 rounded-shop border-2 border-shop-border px-4 py-3 has-checked:border-shop-fg">
            <input type="radio" name="paymentMethod" value={m} required checked={method === m} onChange={() => setMethod(m)} className="row-span-2 mt-1 size-5" />
            <span className="font-medium">{s.methods[m].title}</span>
            <span className="shop-hint">{s.methods[m].text}</span>
          </label>
        ))}
      </fieldset>
      <Terms />
      {!view.b2b ? (
        <p className="shop-hint">
          {s.withdrawal}{' '}
          {shop.legalPaths.withdrawal ? (
            <ShopLink href={shop.legalPaths.withdrawal} className="underline underline-offset-4" target="_blank">
              {s.withdrawalLink}
            </ShopLink>
          ) : null}
        </p>
      ) : null}
      <FormMessage />
      <SubmitButton className="shop-btn shop-btn-primary w-full text-lg" pendingText={s.placing}>
        {method === 'invoice' ? format(s.placeOrder, { amount }) : format(s.pay, { amount })}
      </SubmitButton>
      <p className="shop-hint">{method === 'mollie' ? s.mollieNote : s.invoiceNote}</p>
    </ShopForm>
  )
}

function OrderSummary({ cart }: Readonly<{ cart: Cart }>) {
  const { shop } = useShop()
  const money = useMoney()
  const s = shop.strings
  return (
    <aside aria-labelledby="order-summary" className="flex flex-col gap-5 self-start rounded-shop bg-shop-muted p-6 text-shop-on-muted">
      <h2 id="order-summary" className="text-xl font-semibold">
        {s.checkout.yourOrder}
      </h2>
      <ul className="flex flex-col gap-3">
        {cart.items.map((line) => (
          <li key={line.id} className="flex justify-between gap-4">
            <span>
              {line.quantity} × {line.name}
              {line.variantName ? <span className="block text-sm">{line.variantName}</span> : null}
            </span>
            <span className="tabular-nums">{money(line.total, cart.currency)}</span>
          </li>
        ))}
      </ul>
      <Totals totals={cart} shippingKnown={Boolean(cart.shippingRate)} taxKnown={Boolean(cart.shippingAddress)} />
      {cart.viesUnavailable ? <p className="shop-hint">{s.checkout.viesUnavailable}</p> : null}
      {cart.discount ? <p>{format(s.cart.discountApplied, { code: cart.discount.code })}</p> : null}
      <ShopLink href="/cart" className="text-sm font-medium underline underline-offset-4">
        {s.checkout.changeCart}
      </ShopLink>
    </aside>
  )
}

function Gate({ text, href, label }: Readonly<{ text: string; href: string; label: string }>) {
  const { shop } = useShop()
  return (
    <div className="shop-container shop-section flex max-w-2xl flex-col items-start gap-4">
      <h1 className="text-3xl font-semibold">{shop.strings.checkout.title}</h1>
      <p>{text}</p>
      <ShopLink href={href} className="shop-btn shop-btn-primary">
        {label}
      </ShopLink>
    </div>
  )
}

export function CheckoutPage({ view }: Readonly<{ view: CheckoutView }>) {
  const { shop } = useShop()
  const money = useMoney()
  const s = shop.strings.checkout
  if (view.gate === 'sign-in') return <Gate text={s.signInToCheckout} href="/account?next=%2Fcheckout" label={s.signInButton} />
  if (view.gate === 'company') return <Gate text={s.chooseCompany} href="/account" label={s.chooseCompanyButton} />
  const { company } = view
  return (
    <div className="shop-container shop-section flex flex-col gap-8">
      <QueryError />
      <h1 className="text-3xl font-semibold md:text-4xl">{s.title}</h1>
      {company ? (
        <p>
          {format(s.buyingFor, { company: company.name })}{' '}
          {company.spendLimit && company.currency ? format(s.approvalAbove, { limit: money(company.spendLimit, company.currency) }) : null}
        </p>
      ) : null}
      <div className="grid gap-8 lg:grid-cols-[1fr_22rem]">
        <div className="flex flex-col gap-6">
          <Step number={1} title={s.detailsStep}>
            <DetailsForm view={view} />
          </Step>
          <Step number={2} title={s.shippingStep}>
            <ShippingForm cart={view.cart} rates={view.rates} />
          </Step>
          <Step number={3} title={s.paymentStep}>
            <PaymentForm view={view} />
          </Step>
        </div>
        <OrderSummary cart={view.cart} />
      </div>
    </div>
  )
}
