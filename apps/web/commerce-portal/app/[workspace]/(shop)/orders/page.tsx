'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { en } from '@weldsuite/i18n/locales/en';
import { portalGet } from '@/lib/client';

const t = en.commerce.portalApp;

type Order = {
  id: string;
  orderNumber: string;
  status: string | null;
  total: string | null;
  currency: string | null;
  paymentReference?: string | null;
  createdAt: string;
};

export default function OrdersPage() {
  const slug = String(useParams().workspace ?? '');
  const [orders, setOrders] = useState<Order[]>([]);

  useEffect(() => {
    void portalGet<{ data: Order[] }>(slug, '/orders')
      .then((res) => setOrders(res.data ?? []))
      .catch(() => undefined);
  }, [slug]);

  return (
    <main className="p-6 space-y-3">
      <h1 className="text-xl font-semibold">{t.orders}</h1>
      {orders.length === 0 && <p className="text-muted-foreground">{t.noItems}</p>}
      <ul className="divide-y">
        {orders.map((o) => (
          <li key={o.id} className="py-3">
            <Link href={`/${slug}/orders/${o.id}`} className="flex justify-between gap-4">
              <span className="font-medium">{o.orderNumber}</span>
              <span className="text-sm text-muted-foreground">
                {o.status} · {o.total} {o.currency}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
