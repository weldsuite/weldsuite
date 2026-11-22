import { isStorefrontError } from '@weldsuite/commerce-sdk';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { OrderDetails } from '@/components/order-details';
import { requestOptions, shopLocale, shopTimeZone, storefront } from '@/lib/commerce';
import { segment, single } from '@/lib/params';

// The link carries a secret token: keep it out of search engines and referrers.
export const metadata: Metadata = { title: 'Your order', robots: { index: false }, referrer: 'no-referrer' };

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * A guest's order, opened with the link from the confirmation email
 * (`/orders/<id>?token=<orderToken>`). Signed-in shoppers' links have no
 * token: they go to their account.
 */
export default async function GuestOrderPage({ params, searchParams }: Readonly<Props>) {
  const id = segment((await params).id);
  const token = single((await searchParams).token);
  if (!token) redirect(`/account/orders/${encodeURIComponent(id)}`);

  let order;
  try {
    order = await storefront().orders.getGuest(id, token, await requestOptions());
  } catch (error) {
    if (isStorefrontError(error, 'NOT_FOUND', 'VALIDATION_ERROR')) notFound();
    throw error;
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-3xl font-semibold">Order {order.orderNumber}</h1>
      <OrderDetails order={order} locale={shopLocale} timeZone={shopTimeZone} />
    </div>
  );
}
