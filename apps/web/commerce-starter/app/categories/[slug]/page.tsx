import { isStorefrontError } from '@weldsuite/commerce-sdk';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache } from 'react';

import { ProductListing } from '@/components/product-listing';
import { requestOptions, storefront } from '@/lib/commerce';
import { segment } from '@/lib/params';

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const getCategory = cache(async (slug: string) => {
  try {
    return await storefront().categories.get(slug, await requestOptions());
  } catch (error) {
    if (isStorefrontError(error, 'NOT_FOUND')) notFound();
    throw error;
  }
});

export async function generateMetadata({ params }: Readonly<Props>): Promise<Metadata> {
  const category = await getCategory(segment((await params).slug));
  return { title: category.name, description: category.description ?? undefined };
}

export default async function CategoryPage({ params, searchParams }: Readonly<Props>) {
  const slug = segment((await params).slug);
  const category = await getCategory(slug);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold">{category.name}</h1>
        {category.description ? <p className="max-w-prose text-ink-muted">{category.description}</p> : null}
      </div>
      {category.children.length > 0 ? (
        <nav aria-label={`In ${category.name}`}>
          {/* role="list": Safari/VoiceOver drops list semantics from lists styled with list-style: none. */}
          <ul role="list" className="flex flex-wrap gap-2">
            {category.children.map((child) => (
              <li key={child.id}>
                <Link
                  href={`/categories/${encodeURIComponent(child.slug)}`}
                  className="inline-flex min-h-11 items-center rounded-full border border-line px-4 hover:border-line-strong"
                >
                  {child.name}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      <ProductListing
        basePath={`/categories/${encodeURIComponent(slug)}`}
        category={category.id}
        searchParams={await searchParams}
      />
    </div>
  );
}
