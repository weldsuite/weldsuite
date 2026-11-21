import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { requestOptions, shopLocale, shopTimeZone, storefront } from '@/lib/commerce';
import { getSessionToken } from '@/lib/data';
import { date, money, statusLabel } from '@/lib/format';
import { single } from '@/lib/params';

export const metadata: Metadata = { title: 'Your orders', robots: { index: false } };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function OrdersPage({ searchParams }: Props) {
  const session = await getSessionToken();
  if (!session) redirect('/account/sign-in?next=/account/orders');
  const cursor = single((await searchParams).cursor);
  const page = await storefront().orders.list(session, { cursor, limit: 20 }, await requestOptions());
  const showApproval = page.data.some((order) => order.approvalStatus && order.approvalStatus !== 'not_required');
  const showPlacedBy = page.data.some((order) => order.placedBy?.name);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <p>
          <Link href="/account" className="text-sm underline underline-offset-4">
            Your account
          </Link>
        </p>
        <h1 className="text-3xl font-semibold">Your orders</h1>
      </div>

      {page.data.length === 0 ? (
        <p className="rounded-lg bg-surface-muted p-6">{cursor ? 'No older orders.' : 'You have no orders yet.'}</p>
      ) : (
        <div role="region" aria-labelledby="orders-caption" tabIndex={0} className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <caption id="orders-caption" className="sr-only">
              Your orders, newest first
            </caption>
            <thead>
              <tr className="border-b border-line text-sm text-ink-muted">
                <th scope="col" className="py-2 pr-4 font-medium">Order</th>
                <th scope="col" className="py-2 pr-4 font-medium">Placed</th>
                {showPlacedBy ? <th scope="col" className="py-2 pr-4 font-medium">By</th> : null}
                <th scope="col" className="py-2 pr-4 font-medium">Status</th>
                <th scope="col" className="py-2 pr-4 font-medium">Payment</th>
                {showApproval ? <th scope="col" className="py-2 pr-4 font-medium">Approval</th> : null}
                <th scope="col" className="py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {page.data.map((order) => (
                <tr key={order.id} className="border-b border-line">
                  <th scope="row" className="py-3 pr-4 font-medium">
                    <Link href={`/account/orders/${encodeURIComponent(order.id)}`} className="text-brand underline underline-offset-4">
                      {order.orderNumber}
                    </Link>
                  </th>
                  <td className="py-3 pr-4 whitespace-nowrap">{date(order.placedAt, shopLocale, shopTimeZone)}</td>
                  {showPlacedBy ? <td className="py-3 pr-4">{order.placedBy?.name ?? ''}</td> : null}
                  <td className="py-3 pr-4">{statusLabel(order.status)}</td>
                  <td className="py-3 pr-4">{statusLabel(order.paymentStatus)}</td>
                  {showApproval ? (
                    <td className="py-3 pr-4">
                      {order.approvalStatus && order.approvalStatus !== 'not_required' ? statusLabel(order.approvalStatus) : ''}
                    </td>
                  ) : null}
                  <td className="py-3 text-right tabular-nums whitespace-nowrap">{money(order.total, order.currency, shopLocale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {cursor || page.pagination.hasMore ? (
        <nav aria-label="Pages" className="flex flex-wrap justify-between gap-3">
          {cursor ? (
            <Link href="/account/orders" className="btn btn-secondary">
              Newest orders
            </Link>
          ) : (
            <span />
          )}
          {page.pagination.hasMore && page.pagination.cursor ? (
            <Link href={`/account/orders?cursor=${encodeURIComponent(page.pagination.cursor)}`} className="btn btn-secondary">
              Older orders
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
