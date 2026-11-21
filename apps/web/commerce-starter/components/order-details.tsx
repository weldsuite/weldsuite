import type { Address, StorefrontOrder } from '@weldsuite/commerce-sdk';

import { countryName, date, statusLabel } from '@/lib/format';

import { OrderLines } from './totals';

function AddressBlock({ title, address, locale }: { title: string; address: Address | null; locale: string }) {
  if (!address) return null;
  const lines = [
    address.name,
    address.company,
    address.line1,
    address.line2,
    [address.postalCode, address.city].filter(Boolean).join(' '),
    address.region,
    address.country ? countryName(address.country, locale) : null,
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-1">
      <h3 className="font-semibold">{title}</h3>
      <address className="not-italic">
        {lines.map((line, index) => (
          <span key={index} className="block">
            {line}
          </span>
        ))}
      </address>
    </div>
  );
}

/** An order: its status, addresses, lines and totals. */
export function OrderDetails({ order, locale, timeZone }: { order: StorefrontOrder; locale: string; timeZone: string }) {
  return (
    <div className="flex flex-col gap-8">
      <dl className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-4 rounded-2xl bg-surface-muted p-5">
        <div>
          <dt className="text-sm text-ink-muted">Placed</dt>
          <dd className="font-medium">{date(order.placedAt, locale, timeZone)}</dd>
        </div>
        <div>
          <dt className="text-sm text-ink-muted">Status</dt>
          <dd className="font-medium">{statusLabel(order.status)}</dd>
        </div>
        <div>
          <dt className="text-sm text-ink-muted">Payment</dt>
          <dd className="font-medium">{statusLabel(order.paymentStatus)}</dd>
        </div>
        <div>
          <dt className="text-sm text-ink-muted">Delivery</dt>
          <dd className="font-medium">{statusLabel(order.fulfillmentStatus)}</dd>
        </div>
        {order.approvalStatus && order.approvalStatus !== 'not_required' ? (
          <div>
            <dt className="text-sm text-ink-muted">Approval</dt>
            <dd className="font-medium">{statusLabel(order.approvalStatus)}</dd>
          </div>
        ) : null}
        {order.placedBy?.name ? (
          <div>
            <dt className="text-sm text-ink-muted">Placed by</dt>
            <dd className="font-medium">{order.placedBy.name}</dd>
          </div>
        ) : null}
      </dl>
      <div className="grid gap-6 sm:grid-cols-2">
        <AddressBlock title="Delivery address" address={order.shippingAddress} locale={locale} />
        <AddressBlock title="Billing address" address={order.billingAddress} locale={locale} />
      </div>
      <OrderLines order={order} locale={locale} />
    </div>
  );
}
