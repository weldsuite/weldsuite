'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { en } from '@weldsuite/i18n/locales/en';
import { clearCart, readCart, type CartLine, writeCart } from '@/lib/cart';
import { portalPost } from '@/lib/client';

const t = en.commerce.portalApp;

export default function CartPage() {
  const slug = String(useParams().workspace ?? '');
  const router = useRouter();
  const [lines, setLines] = useState<CartLine[]>([]);
  const [po, setPo] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setLines(readCart());
  }, []);

  async function checkout(e: FormEvent) {
    e.preventDefault();
    if (!lines.length) return;
    setBusy(true);
    try {
      await portalPost(slug, '/orders', {
        items: lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
        purchaseOrderNumber: po || undefined,
        customerNote: note || undefined,
      });
      clearCart();
      toast.success(t.placed);
      router.push(`/${slug}/orders`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t.placing);
    } finally {
      setBusy(false);
    }
  }

  if (!lines.length) {
    return (
      <main className="p-6">
        <p className="text-muted-foreground">{t.emptyCart}</p>
      </main>
    );
  }

  return (
    <main className="p-6 max-w-xl space-y-4">
      <ul className="divide-y">
        {lines.map((l) => (
          <li key={l.productId} className="py-3 flex justify-between gap-4">
            <div>
              <div className="font-medium">{l.name}</div>
              <div className="text-sm text-muted-foreground">
                {t.qty} {l.quantity} · {l.price}
              </div>
            </div>
            <button
              type="button"
              className="text-sm text-muted-foreground"
              onClick={() => {
                const next = lines.filter((x) => x.productId !== l.productId);
                writeCart(next);
                setLines(next);
              }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={checkout} className="space-y-3">
        <label className="block text-sm">
          {t.poNumber}
          <input value={po} onChange={(e) => setPo(e.target.value)} className="mt-1 w-full rounded-md border px-3 py-2" />
        </label>
        <label className="block text-sm">
          {t.note}
          <textarea value={note} onChange={(e) => setNote(e.target.value)} className="mt-1 w-full rounded-md border px-3 py-2" />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-neutral-900 text-white px-4 py-2 text-sm"
        >
          {busy ? t.placing : t.checkout}
        </button>
      </form>
    </main>
  );
}
