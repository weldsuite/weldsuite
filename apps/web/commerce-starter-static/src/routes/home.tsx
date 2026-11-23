import type { StorefrontCategory, StorefrontProduct } from '@weldsuite/commerce-sdk';
import { Link, useLoaderData } from 'react-router';

import { PageMeta } from '../components/page-meta';
import { ProductGrid } from '../components/product-card';
import { storefront } from '../lib/client';
import { text } from '../lib/messages';
import { categoryPath } from '../lib/urls';

interface HomeData {
  products: StorefrontProduct[];
  categories: StorefrontCategory[];
}

export async function loader(): Promise<HomeData> {
  const [page, categories] = await Promise.all([storefront().products.list({ sort: 'newest', limit: 8 }), storefront().categories.list()]);
  return { products: page.data, categories };
}

export function Component() {
  const { products, categories } = useLoaderData() as HomeData;
  return (
    <div className="flex flex-col gap-12">
      <PageMeta path="/" />
      <section aria-labelledby="new-arrivals" className="flex flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h1 id="new-arrivals" className="text-3xl font-semibold">
            {text.newArrivals}
          </h1>
          <Link to="/products" className="font-medium underline underline-offset-4">
            {text.viewAll}
          </Link>
        </div>
        {products.length > 0 ? <ProductGrid products={products} /> : <p>{text.noProducts}</p>}
      </section>
      {categories.length > 0 ? (
        <section aria-labelledby="by-category" className="flex flex-col gap-6">
          <h2 id="by-category" className="text-2xl font-semibold">
            {text.shopByCategory}
          </h2>
          <ul role="list" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {categories.map((category) => (
              <li key={category.id} className="relative rounded-xl border border-line p-5 hover:bg-surface-muted">
                <Link to={categoryPath(category.slug)} className="card-link text-lg font-semibold">
                  {category.name}
                </Link>
                {category.description ? <p className="mt-1 line-clamp-2 hint">{category.description}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
