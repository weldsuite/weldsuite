import Link from 'next/link';

import { ProductGrid } from '@/components/product-card';
import { requestOptions, shopLocale, storefront } from '@/lib/commerce';
import { getCategories, getChannel } from '@/lib/data';

export default async function HomePage() {
  const [channel, categories, latest] = await Promise.all([
    getChannel(),
    getCategories(),
    storefront().products.list({ sort: 'newest', limit: 8, ...(await requestOptions()) }),
  ]);

  return (
    <div className="flex flex-col gap-12">
      <section aria-labelledby="welcome" className="rounded-2xl bg-brand-soft px-6 py-12 sm:px-10">
        <h1 id="welcome" className="text-3xl font-bold tracking-tight text-balance sm:text-4xl">
          Welcome to {channel.name}
        </h1>
        <p className="mt-3 max-w-prose text-lg text-pretty">
          {channel.audience === 'b2b'
            ? 'Order for your business: prices exclude VAT, pay on invoice or online, and reorder in a few clicks.'
            : 'Find something you like and check out in a minute, with or without an account.'}
        </p>
        <p className="mt-6">
          <Link href="/products" className="btn btn-primary">
            Browse all products
          </Link>
        </p>
      </section>

      {categories.length > 0 ? (
        <section aria-labelledby="shop-by-category" className="flex flex-col gap-4">
          <h2 id="shop-by-category" className="text-2xl font-semibold">
            Shop by category
          </h2>
          {/* role="list": Safari/VoiceOver drops list semantics from lists styled with list-style: none. */}
          <ul role="list" className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,12rem),1fr))] gap-3">
            {categories.map((category) => (
              <li key={category.id}>
                <Link
                  href={`/categories/${encodeURIComponent(category.slug)}`}
                  className="flex min-h-16 items-center rounded-xl border border-line px-4 py-3 font-medium hover:border-line-strong"
                >
                  {category.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="new-in" className="flex flex-col gap-4">
        <h2 id="new-in" className="text-2xl font-semibold">
          New in
        </h2>
        {latest.data.length > 0 ? (
          <ProductGrid products={latest.data} locale={shopLocale} />
        ) : (
          <p className="rounded-lg bg-surface-muted p-6">No products yet. Add some in WeldCommerce and give them a price in {channel.currency}.</p>
        )}
      </section>
    </div>
  );
}
