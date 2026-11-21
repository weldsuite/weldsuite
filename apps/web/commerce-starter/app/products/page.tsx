import type { Metadata } from 'next';

import { ProductListing } from '@/components/product-listing';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ searchParams }: Readonly<Props>): Promise<Metadata> {
  const { search } = await searchParams;
  return { title: typeof search === 'string' && search ? `Search: ${search}` : 'All products' };
}

export default async function ProductsPage({ searchParams }: Readonly<Props>) {
  const params = await searchParams;
  const search = typeof params.search === 'string' ? params.search.trim() : '';
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-3xl font-semibold">{search ? `Results for “${search}”` : 'All products'}</h1>
      <ProductListing basePath="/products" searchParams={params} />
    </div>
  );
}
