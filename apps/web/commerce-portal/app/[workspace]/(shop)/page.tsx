'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { en } from '@weldsuite/i18n/locales/en';
import { portalGet } from '@/lib/client';
import { addToCart } from '@/lib/cart';

const t = en.commerce.portalApp;

type Product = {
  id: string;
  name: string;
  price: string;
  currency?: string | null;
  featuredImageUrl?: string | null;
  shortDescription?: string | null;
};

export default function CatalogPage() {
  const slug = String(useParams().workspace ?? '');
  const [products, setProducts] = useState<Product[]>([]);

  useEffect(() => {
    void portalGet<{ data: Product[] }>(slug, '/products?limit=100')
      .then((res) => setProducts(res.data ?? []))
      .catch(() => undefined);
  }, [slug]);

  return (
    <main className="p-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {products.length === 0 && <p className="text-muted-foreground">{t.noItems}</p>}
      {products.map((p) => (
        <article key={p.id} className="rounded-lg border p-4 space-y-2">
          {p.featuredImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.featuredImageUrl} alt="" className="h-40 w-full object-cover rounded-md" />
          ) : null}
          <h2 className="font-medium">{p.name}</h2>
          {p.shortDescription && <p className="text-sm text-muted-foreground">{p.shortDescription}</p>}
          <p className="text-sm">
            {t.price}: {p.price} {p.currency}
          </p>
          <button
            type="button"
            className="rounded-md bg-neutral-900 text-white px-3 py-1.5 text-sm"
            onClick={() => {
              addToCart({
                productId: p.id,
                name: p.name,
                price: p.price,
                imageUrl: p.featuredImageUrl,
                currency: p.currency,
              });
              toast.success(t.addToCart);
            }}
          >
            {t.addToCart}
          </button>
        </article>
      ))}
    </main>
  );
}
