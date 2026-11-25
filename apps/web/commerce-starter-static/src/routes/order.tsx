import type { StorefrontOrder } from '@weldsuite/commerce-sdk';
import { data, useLoaderData, type LoaderFunctionArgs } from 'react-router';

import { PageMeta } from '../components/page-meta';
import { Totals } from '../components/totals';
import { config, storefront } from '../lib/client';
import { countryName, date, money, statusLabel } from '../lib/format';
import { text } from '../lib/messages';

/** A guest's order, by the link in the confirmation email (`/orders/<id>?token=…`, the `orderUrl` template). */
export async function loader({ request, params }: LoaderFunctionArgs): Promise<StorefrontOrder> {
  const token = new URL(request.url).searchParams.get('token');
  if (!token || !params.id) throw data(null, { status: 404 });
  try {
    return await storefront().orders.getGuest(params.id, token);
  } catch {
    throw data(null, { status: 404 });
  }
}

/** An order's lines and totals. */
export function OrderLines({ order }: Readonly<{ order: StorefrontOrder }>) {
  const locale = config?.locale ?? 'en-IE';
  return (
    <section aria-labelledby={`order-${order.id}`} className="flex flex-col gap-6">
      <h2 id={`order-${order.id}`} className="text-xl font-semibold">
        {text.orderTitle(order.orderNumber)}
      </h2>
      <table className="w-full">
        <thead>
          <tr className="border-b border-line text-sm">
            <th scope="col" className="py-2 text-start font-medium">
              {text.item}
            </th>
            <th scope="col" className="py-2 text-end font-medium">
              {text.quantity}
            </th>
            <th scope="col" className="py-2 text-end font-medium">
              {text.total}
            </th>
          </tr>
        </thead>
        <tbody>
          {order.items.map((item) => (
            <tr key={item.id} className="border-b border-line align-top">
              <td className="py-3 pe-3">
                {item.name}
                {item.variantName ? <span className="block hint">{item.variantName}</span> : null}
              </td>
              <td className="py-3 text-end tabular-nums">{item.quantity}</td>
              <td className="py-3 text-end tabular-nums">{money(item.total, order.currency, locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="ms-auto w-full max-w-sm">
        <Totals totals={order} shippingKnown taxKnown />
      </div>
    </section>
  );
}

export function Component() {
  const order = useLoaderData() as StorefrontOrder;
  const locale = config?.locale ?? 'en-IE';
  const address = order.shippingAddress;
  return (
    <div className="flex flex-col gap-8">
      <PageMeta title={text.orderTitle(order.orderNumber)} />
      <meta name="robots" content="noindex" />
      {/* The order token is in the URL: never send it on. */}
      <meta name="referrer" content="no-referrer" />
      <div className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold">{text.orderTitle(order.orderNumber)}</h1>
        <p className="hint">{text.placedOn(date(order.placedAt, locale))}</p>
      </div>
      <dl className="grid gap-4 sm:grid-cols-3">
        <div>
          <dt className="hint">{text.status}</dt>
          <dd className="font-medium">{statusLabel(order.status)}</dd>
        </div>
        <div>
          <dt className="hint">{text.payment}</dt>
          <dd className="font-medium">{statusLabel(order.paymentStatus)}</dd>
        </div>
        {address ? (
          <div>
            <dt className="hint">{text.deliveryAddress}</dt>
            <dd>
              <address className="not-italic">
                {[address.name, address.line1, address.line2, [address.postalCode, address.city].filter(Boolean).join(' '), address.country ? countryName(address.country, locale) : null]
                  .filter(Boolean)
                  .map((line, index) => (
                    <span key={index} className="block">
                      {line}
                    </span>
                  ))}
              </address>
            </dd>
          </div>
        ) : null}
      </dl>
      <OrderLines order={order} />
    </div>
  );
}
