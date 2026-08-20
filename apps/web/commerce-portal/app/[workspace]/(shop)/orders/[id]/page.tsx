'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { en } from '@weldsuite/i18n/locales/en';
import { portalGet } from '@/lib/client';

const t = en.commerce.portalApp;

type OrderDetail = {
  id: string;
  orderNumber: string;
  status: string | null;
  fulfillmentStatus: string | null;
  total: string | null;
  currency: string | null;
  paymentReference?: string | null;
  customerNote?: string | null;
  items?: Array<{ id: string; name: string; quantity: number; unitPrice: string; total: string }>;
};

export default function OrderDetailPage() {
  const params = useParams();
  const slug = String(params.workspace ?? '');
  const id = String(params.id ?? '');
  const [order, setOrder] = useState<OrderDetail | null>(null);

  useEffect(() => {
    void portalGet<{ data: OrderDetail }>(slug, `/orders/${id}`)
      .then((res) => setOrder(res.data))
      .catch(() => undefined);
  }, [slug, id]);

  if (!order) return <main className="p-6">{t.noItems}</main>;

  return (
    <main className="p-6 space-y-4 max-w-2xl">
      <h1 className="text-xl font-semibold">{order.orderNumber}</h1>
      <p className="text-sm text-muted-foreground">
        {order.status} · {order.fulfillmentStatus}
        {order.paymentReference ? ` · PO ${order.paymentReference}` : ''}
      </p>
      <ul className="divide-y">
        {(order.items ?? []).map((item) => (
          <li key={item.id} className="py-2 flex justify-between">
            <span>
              {item.name} × {item.quantity}
            </span>
            <span>
              {item.total} {order.currency}
            </span>
          </li>
        ))}
      </ul>
      <p className="font-medium">
        {t.total}: {order.total} {order.currency}
      </p>
    </main>
  );
}
