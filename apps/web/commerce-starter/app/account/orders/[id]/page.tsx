import { isStorefrontError } from '@weldsuite/commerce-sdk';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { ReorderForm } from '@/components/account-forms';
import { OrderDetails } from '@/components/order-details';
import { requestOptions, shopLocale, shopTimeZone, storefront } from '@/lib/commerce';
import { getSessionToken } from '@/lib/data';
import { segment } from '@/lib/params';

export const metadata: Metadata = { title: 'Order', robots: { index: false } };

type Props = { params: Promise<{ id: string }> };

export default async function AccountOrderPage({ params }: Props) {
  const id = segment((await params).id);
  const session = await getSessionToken();
  if (!session) redirect(`/account/sign-in?next=${encodeURIComponent('/account/orders/' + id)}`);

  let order;
  try {
    order = await storefront().orders.get(session, id, await requestOptions());
  } catch (error) {
    if (isStorefrontError(error, 'NOT_FOUND')) notFound();
    throw error;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <p>
          <Link href="/account/orders" className="text-sm underline underline-offset-4">
            Your orders
          </Link>
        </p>
        <h1 className="text-3xl font-semibold">Order {order.orderNumber}</h1>
      </div>
      <ReorderForm orderId={order.id} />
      <OrderDetails order={order} locale={shopLocale} timeZone={shopTimeZone} />
    </div>
  );
}
