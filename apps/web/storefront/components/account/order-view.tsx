import type { StorefrontOrder } from '@weldsuite/commerce-sdk'
import { AddressLines, format, OrderLines, ShopLink, statusLabel, useMoney, useShop } from '@weldsuite/storefront-theme'
import type { ReactNode } from 'react'

/** A date in the shop's language. */
export function useDate(): (iso: string) => string {
  const { shop } = useShop()
  return (iso) => {
    const at = new Date(iso)
    return Number.isNaN(at.getTime()) ? iso : new Intl.DateTimeFormat(shop.intlLocale, { dateStyle: 'medium' }).format(at)
  }
}

/** One order: its state, lines, totals and addresses (account and guest order pages). */
export function OrderView({ order, actions }: Readonly<{ order: StorefrontOrder; actions?: ReactNode }>) {
  const { shop } = useShop()
  const s = shop.strings.order
  const date = useDate()
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold md:text-4xl">{format(s.title, { number: order.orderNumber })}</h1>
          <p className="shop-hint">{format(s.placedOn, { date: date(order.placedAt) })}</p>
          {order.placedBy?.name ? <p className="shop-hint">{format(s.placedBy, { name: order.placedBy.name })}</p> : null}
        </div>
        {actions}
      </div>
      <dl className="grid gap-4 sm:grid-cols-3">
        <div>
          <dt className="shop-hint">{s.status}</dt>
          <dd className="font-medium">{statusLabel(shop.strings, 'order', order.status)}</dd>
        </div>
        <div>
          <dt className="shop-hint">{s.payment}</dt>
          <dd className="font-medium">{statusLabel(shop.strings, 'payment', order.paymentStatus)}</dd>
        </div>
        {order.approvalStatus !== 'not_required' ? (
          <div>
            <dt className="shop-hint">{s.approval}</dt>
            <dd className="font-medium">{statusLabel(shop.strings, 'approval', order.approvalStatus)}</dd>
          </div>
        ) : null}
      </dl>
      <OrderLines order={order} />
      <div className="grid gap-6 sm:grid-cols-2">
        {order.shippingAddress ? (
          <section aria-labelledby="shipping-address" className="flex flex-col gap-2">
            <h2 id="shipping-address" className="text-lg font-semibold">
              {s.shippingAddress}
            </h2>
            <AddressLines address={order.shippingAddress} />
          </section>
        ) : null}
        {order.billingAddress ? (
          <section aria-labelledby="billing-address" className="flex flex-col gap-2">
            <h2 id="billing-address" className="text-lg font-semibold">
              {s.billingAddress}
            </h2>
            <AddressLines address={order.billingAddress} />
          </section>
        ) : null}
      </div>
    </div>
  )
}

/** Orders in a table: number (the link), date, status, total. */
export function OrdersTable({ orders }: Readonly<{ orders: StorefrontOrder[] }>) {
  const { shop } = useShop()
  const s = shop.strings.order
  const date = useDate()
  return (
    <table className="w-full">
      <caption className="sr-only">{shop.strings.account.orders}</caption>
      <thead>
        <tr className="border-b border-shop-border text-sm">
          <th scope="col" className="py-2 text-start font-medium">
            {s.number}
          </th>
          <th scope="col" className="py-2 text-start font-medium">
            {s.date}
          </th>
          <th scope="col" className="hidden py-2 text-start font-medium sm:table-cell">
            {s.status}
          </th>
          <th scope="col" className="py-2 text-end font-medium">
            {s.total}
          </th>
        </tr>
      </thead>
      <tbody>
        {orders.map((order) => (
          <OrderRow key={order.id} order={order} date={date(order.placedAt)} />
        ))}
      </tbody>
    </table>
  )
}


function OrderRow({ order, date }: Readonly<{ order: StorefrontOrder; date: string }>) {
  const { shop } = useShop()
  const money = useMoney()
  return (
    <tr className="border-b border-shop-border">
      <td className="py-3">
        <ShopLink href={`/account/orders/${encodeURIComponent(order.id)}`} className="font-medium underline underline-offset-4">
          {order.orderNumber}
        </ShopLink>
      </td>
      <td className="py-3">{date}</td>
      <td className="hidden py-3 sm:table-cell">{statusLabel(shop.strings, 'order', order.status)}</td>
      <td className="py-3 text-end tabular-nums">{money(order.total, order.currency)}</td>
    </tr>
  )
}
