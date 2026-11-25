/**
 * Loads what a page's sections asked for (`sectionDataNeeds`): products for
 * featured and related products, the category tree for category lists. A
 * failure leaves that section empty instead of failing the page.
 */

import { isStorefrontError, type StorefrontProduct } from '@weldsuite/commerce-sdk';
import { sectionDataNeeds, type ListName, type SectionData, type SectionList, type ShopData } from '@weldsuite/storefront-theme';
import type { ShopRequest } from './shop';

async function chosenProducts(shop: ShopRequest, refs: string[], limit: number): Promise<StorefrontProduct[]> {
  const found = await Promise.all(
    refs.slice(0, limit).map((ref) =>
      shop.client.products.get(ref, shop.options).catch((error: unknown) => {
        if (isStorefrontError(error, 'NOT_FOUND')) return null;
        throw error;
      }),
    ),
  );
  return found.filter((product): product is StorefrontProduct => product !== null);
}

export async function loadSectionData(
  shop: ShopRequest,
  lists: Array<{ list: ListName; sections: SectionList | undefined }>,
  product?: StorefrontProduct | null,
): Promise<Pick<ShopData, 'sections' | 'categories'>> {
  const needs = sectionDataNeeds(lists);
  const sections: Record<string, SectionData> = {};
  const work = needs.sections.map(async (request) => {
    try {
      if (request.kind === 'related') {
        const category = product?.categories[0];
        if (!product || !category) return;
        const page = await shop.client.products.list({ ...shop.options, category: category.id, limit: request.limit + 1 });
        sections[request.key] = { products: page.data.filter((other) => other.id !== product.id).slice(0, request.limit) };
      } else if (request.source === 'products') {
        sections[request.key] = { products: await chosenProducts(shop, request.products, request.limit) };
      } else {
        const page = await shop.client.products.list({
          ...shop.options,
          limit: request.limit,
          ...(request.source === 'category' && request.category ? { category: request.category } : { sort: 'newest' as const }),
        });
        sections[request.key] = { products: page.data };
      }
    } catch (error) {
      console.error('[storefront] section data', request.key, error instanceof Error ? error.message : error);
    }
  });
  const categories = needs.categories
    ? shop.client.categories.list(shop.options).catch((error: unknown) => {
        console.error('[storefront] categories', error instanceof Error ? error.message : error);
        return [];
      })
    : Promise.resolve(undefined);
  const [tree] = await Promise.all([categories, ...work]);
  return { sections, ...(tree ? { categories: tree } : {}) };
}
