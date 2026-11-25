import type { Shopper, StorefrontOrder } from '@weldsuite/commerce-sdk'
import { format, ShopLink, useMoney, useShop } from '@weldsuite/storefront-theme'
import { selectCompany, signOut, updateProfile } from '@/lib/server/actions/account'
import { Field, FormMessage, ShopForm, SubmitButton } from '../shop-form'
import { QueryError } from '../template-view'
import { OrdersTable } from './order-view'

function Companies({ shopper }: Readonly<{ shopper: Shopper }>) {
  const { shop } = useShop()
  const money = useMoney()
  const s = shop.strings.account
  if (shopper.companies.length === 0) return null
  return (
    <section aria-labelledby="companies" className="flex flex-col gap-4">
      <h2 id="companies" className="text-xl font-semibold">
        {s.companies}
      </h2>
      <ShopForm action={selectCompany} className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">{s.company}</legend>
          {shopper.companies.map((company) => (
            <label key={company.id} className="grid cursor-pointer grid-cols-[auto_1fr] items-start gap-x-3 rounded-shop border-2 border-shop-border px-4 py-3 has-checked:border-shop-fg">
              <input type="radio" name="companyId" value={company.id} required defaultChecked={company.id === shopper.activeCompanyId} className="row-span-2 mt-1 size-5" />
              <span className="font-medium">{company.name}</span>
              <span className="shop-hint">
                {s.roles[company.role]}
                {company.spendLimit && company.currency ? ` · ${format(s.spendLimit, { limit: money(company.spendLimit, company.currency) })}` : ''}
              </span>
            </label>
          ))}
        </fieldset>
        <FormMessage />
        <div>
          <SubmitButton className="shop-btn shop-btn-secondary">{s.useCompany}</SubmitButton>
        </div>
      </ShopForm>
    </section>
  )
}

/** The signed-in shopper's account: details, companies (B2B), recent orders, sign out. */
export function AccountPage({ shopper, orders, b2b }: Readonly<{ shopper: Shopper; orders: StorefrontOrder[]; b2b: boolean }>) {
  const { shop } = useShop()
  const s = shop.strings.account
  const company = shopper.companies.find((candidate) => candidate.id === shopper.activeCompanyId)
  const approver = company?.role === 'approver' || company?.role === 'admin'
  return (
    <div className="shop-container shop-section flex flex-col gap-10">
      <QueryError />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold md:text-4xl">{s.title}</h1>
          <p className="shop-hint">{format(s.signedInAs, { email: shopper.email })}</p>
          {company ? <p>{format(s.activeCompany, { company: company.name })}</p> : null}
        </div>
        <ShopForm action={signOut}>
          <SubmitButton className="shop-btn shop-btn-secondary">{s.signOut}</SubmitButton>
        </ShopForm>
      </div>
      {b2b && company ? (
        <nav aria-label="B2B" className="flex flex-wrap gap-3">
          <ShopLink href="/quick-order" className="shop-btn shop-btn-secondary">
            {shop.strings.nav.quickOrder}
          </ShopLink>
          {approver ? (
            <ShopLink href="/account/approvals" className="shop-btn shop-btn-secondary">
              {shop.strings.nav.approvals}
            </ShopLink>
          ) : null}
        </nav>
      ) : null}
      <section aria-labelledby="recent-orders" className="flex flex-col gap-4">
        <div className="flex items-end justify-between gap-4">
          <h2 id="recent-orders" className="text-xl font-semibold">
            {s.recentOrders}
          </h2>
          {orders.length > 0 ? (
            <ShopLink href="/account/orders" className="font-medium underline underline-offset-4">
              {s.allOrders}
            </ShopLink>
          ) : null}
        </div>
        {orders.length > 0 ? <OrdersTable orders={orders} /> : <p>{s.noOrders}</p>}
      </section>
      {b2b ? <Companies shopper={shopper} /> : null}
      <section aria-labelledby="profile" className="flex max-w-xl flex-col gap-4">
        <h2 id="profile" className="text-xl font-semibold">
          {s.profile}
        </h2>
        <ShopForm action={updateProfile} className="grid gap-4 sm:grid-cols-2">
          <Field name="firstName" label={s.firstName} optional autoComplete="given-name" maxLength={100} defaultValue={shopper.firstName ?? ''} />
          <Field name="lastName" label={s.lastName} optional autoComplete="family-name" maxLength={100} defaultValue={shopper.lastName ?? ''} />
          <Field className="sm:col-span-2" name="phone" label={s.phone} optional type="tel" autoComplete="tel" maxLength={50} defaultValue={shopper.phone ?? ''} />
          <div className="sm:col-span-2">
            <FormMessage />
          </div>
          <div>
            <SubmitButton pendingText={shop.strings.common.saving}>{s.saveProfile}</SubmitButton>
          </div>
        </ShopForm>
      </section>
    </div>
  )
}
