'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { en } from '@weldsuite/i18n/locales/en';
import { portalGet, portalPost } from '@/lib/client';

const t = en.commerce.portalApp;

type Order = {
  id: string;
  orderNumber: string;
  items?: Array<{ productId?: string; name: string; sku?: string; quantity: number }>;
};
type Reason = { id: string; code: string; label: string };
type ReturnRow = { id: string; returnNumber: string; status: string; originalOrderId: string | null };

export default function ReturnsPage() {
  const slug = String(useParams().workspace ?? '');
  const [returns, setReturns] = useState<ReturnRow[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [reasons, setReasons] = useState<Reason[]>([]);
  const [orderId, setOrderId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void Promise.all([
      portalGet<{ data: ReturnRow[] }>(slug, '/returns'),
      portalGet<{ data: Order[] }>(slug, '/orders'),
      portalGet<{ data: Reason[] }>(slug, '/return-reasons'),
    ])
      .then(([r, o, reasonsRes]) => {
        setReturns(r.data ?? []);
        setOrders(o.data ?? []);
        setReasons(reasonsRes.data ?? []);
      })
      .catch(() => undefined);
  }, [slug]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!orderId) return;
    const detail = await portalGet<{ data: Order }>(slug, `/orders/${orderId}`);
    const items = (detail.data.items ?? []).map((item) => ({
      productId: item.productId,
      productName: item.name,
      sku: item.sku,
      quantity: item.quantity,
    }));
    if (!items.length) return;
    setBusy(true);
    try {
      await portalPost(slug, '/returns', {
        originalOrderId: orderId,
        reason: reason || undefined,
        items,
      });
      toast.success(t.submitReturn);
      const list = await portalGet<{ data: ReturnRow[] }>(slug, '/returns');
      setReturns(list.data ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t.submitReturn);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="p-6 space-y-6 max-w-xl">
      <h1 className="text-xl font-semibold">{t.returns}</h1>
      <form onSubmit={submit} className="space-y-3 rounded-lg border p-4">
        <h2 className="font-medium">{t.requestReturn}</h2>
        <label className="block text-sm">
          {t.orders}
          <select
            value={orderId}
            onChange={(e) => setOrderId(e.target.value)}
            className="mt-1 w-full rounded-md border px-3 py-2"
          >
            <option value="">—</option>
            {orders.map((o) => (
              <option key={o.id} value={o.id}>
                {o.orderNumber}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          {t.reason}
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="mt-1 w-full rounded-md border px-3 py-2"
          >
            <option value="">—</option>
            {reasons.map((r) => (
              <option key={r.id} value={r.code}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={busy || !orderId}
          className="rounded-md bg-neutral-900 text-white px-4 py-2 text-sm"
        >
          {t.submitReturn}
        </button>
      </form>
      <ul className="divide-y">
        {returns.map((r) => (
          <li key={r.id} className="py-2 flex justify-between">
            <span>{r.returnNumber}</span>
            <span className="text-sm text-muted-foreground">{r.status}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
