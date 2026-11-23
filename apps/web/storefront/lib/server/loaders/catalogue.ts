/** Loaders of the catalogue pages: home, all products, a category, a product, search, cart, content pages. */

import { notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { isStorefrontError, type ProductSort, type StorefrontCategory } from '@weldsuite/commerce-sdk';
import { format, plainText, sectionSettings, t, type ProductListing, type SectionList } from '@weldsuite/storefront-theme';
import { z } from 'zod';
import { buyingClosed, catalogueClosed, showsPrices } from '../../access';
import type { TemplatePage } from '../../payload';
import { withQuery } from '../../paths';
import { breadcrumbJsonLd, makeHead, productJsonLd } from '../../seo';
import { headContext } from '../head';
import { loadSectionData } from '../section-data';
import { currentCart, currentShopper, shopRequest, type ShopRequest } from '../shop';

const SORTS = ['name', '-name', 'price', '-price', 'newest'] as const;

const listingInput = z.object({
  sort: z.enum(SORTS).optional(),
  cursor: z.string().max(500).optional(),
});

/** Guests are sent to sign in from catalogue pages of a `signed_in` shop. */
async function gate(shop: ShopRequest, path: string): Promise<void> {
  if (catalogueClosed(shop.doc.settings.access, Boolean(await currentShopper(shop)))) {
    throw redirect({ href: withQuery('/account', { next: path }) });
  }
}

function pageSize(sections: SectionList, type: string): number {
  const main = sections.find((section) => section.type === type);
  return main ? sectionSettings(type, main.settings).number('pageSize') : 24;
}

async function listing(
  shop: ShopRequest,
  input: { kind: ProductListing['kind']; category: StorefrontCategory | null; query: string; sort?: ProductSort; cursor?: string; path: string; limit: number },
): Promise<ProductListing> {
  const sort = input.sort ?? 'name';
  const list = (cursor: string | undefined) =>
    shop.client.products.list({
      ...shop.options,
      sort,
      limit: input.limit,
      ...(input.category ? { category: input.category.id } : {}),
      ...(input.query ? { search: input.query.slice(0, 100) } : {}),
      ...(cursor ? { cursor } : {}),
    });
  let cursor = input.cursor;
  let page;
  try {
    page = await list(cursor);
  } catch (error) {
    // An old or edited cursor: start again from the first page.
    if (!cursor || !isStorefrontError(error, 'INVALID_CURSOR')) throw error;
    cursor = undefined;
    page = await list(undefined);
  }
  const base = { q: input.query || null, sort: input.sort && input.sort !== 'name' ? input.sort : null };
  return {
    kind: input.kind,
    category: input.category,
    query: input.query,
    products: page.data,
    sort,
    path: input.path,
    nextHref: page.pagination.hasMore && page.pagination.cursor ? withQuery(input.path, { ...base, cursor: page.pagination.cursor }) : null,
    firstHref: cursor ? withQuery(input.path, base) : null,
  };
}

export const getHomePage = createServerFn({ method: 'GET' }).handler(async (): Promise<TemplatePage> => {
  const shop = await shopRequest();
  await gate(shop, '/');
  const sections = shop.doc.templates.home;
  const data = await loadSectionData(shop, [{ list: 'home', sections }]);
  return { template: 'home', sections, data, head: makeHead(headContext(shop), { title: null, path: '/' }) };
});

export const getAllProductsPage = createServerFn({ method: 'GET' })
  .validator(listingInput)
  .handler(async ({ data: input }): Promise<TemplatePage> => {
    const shop = await shopRequest();
    await gate(shop, '/products');
    const sections = shop.doc.templates.category;
    const s = t(shop.site.locale);
    const [result, sectionData] = await Promise.all([
      listing(shop, { kind: 'all', category: null, query: '', ...input, path: '/products', limit: pageSize(sections, 'main-category') }),
      loadSectionData(shop, [{ list: 'category', sections }]),
    ]);
    return {
      template: 'category',
      sections,
      data: { ...sectionData, listing: result },
      head: makeHead(headContext(shop), { title: s.listing.allProducts, path: '/products' }),
    };
  });

export const getCategoryPage = createServerFn({ method: 'GET' })
  .validator(listingInput.extend({ slug: z.string().min(1).max(200) }))
  .handler(async ({ data: input }): Promise<TemplatePage> => {
    const shop = await shopRequest();
    const requested = `/categories/${encodeURIComponent(input.slug)}`;
    await gate(shop, requested);
    let category: StorefrontCategory;
    try {
      category = await shop.client.categories.get(input.slug, shop.options);
    } catch (error) {
      if (isStorefrontError(error, 'NOT_FOUND')) throw notFound();
      throw error;
    }
    const path = `/categories/${encodeURIComponent(category.slug)}`;
    // Menus link categories by id: one address per category, the slug's.
    if (category.slug && category.slug !== input.slug) {
      throw redirect({ href: withQuery(path, { sort: input.sort ?? null }), statusCode: 301 });
    }
    const sections = shop.doc.templates.category;
    const ctx = headContext(shop);
    const [result, sectionData] = await Promise.all([
      listing(shop, { kind: 'category', category, query: '', ...input, path, limit: pageSize(sections, 'main-category') }),
      loadSectionData(shop, [{ list: 'category', sections }]),
    ]);
    return {
      template: 'category',
      sections,
      data: { ...sectionData, listing: result },
      head: makeHead(ctx, {
        title: category.name,
        description: plainText(category.description),
        path,
        jsonLd: [breadcrumbJsonLd(ctx, [{ name: ctx.strings.common.home, path: '/' }, { name: category.name, path }])],
      }),
    };
  });

export const getProductPage = createServerFn({ method: 'GET' })
  .validator(z.object({ slug: z.string().min(1).max(200) }))
  .handler(async ({ data: input }): Promise<TemplatePage> => {
    const shop = await shopRequest();
    await gate(shop, `/products/${encodeURIComponent(input.slug)}`);
    let product;
    try {
      product = await shop.client.products.get(input.slug, shop.options);
    } catch (error) {
      if (isStorefrontError(error, 'NOT_FOUND')) throw notFound();
      throw error;
    }
    const path = `/products/${encodeURIComponent(product.slug)}`;
    if (product.slug && product.slug !== input.slug) throw redirect({ href: path, statusCode: 301 });
    const sections = shop.doc.templates.product;
    const [sectionData, shopper] = await Promise.all([loadSectionData(shop, [{ list: 'product', sections }], product), currentShopper(shop)]);
    const ctx = headContext(shop);
    const category = product.categories[0];
    const trail = [
      { name: ctx.strings.common.home, path: '/' },
      ...(category ? [{ name: category.name, path: `/categories/${encodeURIComponent(category.slug)}` }] : []),
      { name: product.name, path },
    ];
    return {
      template: 'product',
      sections,
      data: { ...sectionData, product },
      head: makeHead(ctx, {
        title: product.name,
        description: plainText(product.description),
        path,
        image: product.featuredImageUrl ?? product.images[0]?.url ?? null,
        ogType: 'product',
        jsonLd: [productJsonLd(ctx, product, path, showsPrices(shop.doc.settings.access, shopper !== null)), breadcrumbJsonLd(ctx, trail)],
      }),
    };
  });

export const getSearchPage = createServerFn({ method: 'GET' })
  .validator(listingInput.extend({ q: z.string().max(200).optional() }))
  .handler(async ({ data: input }): Promise<TemplatePage> => {
    const shop = await shopRequest();
    await gate(shop, '/search');
    const query = (input.q ?? '').trim().slice(0, 100);
    const sections = shop.doc.templates.search;
    const s = t(shop.site.locale);
    const [result, sectionData] = await Promise.all([
      query ? listing(shop, { kind: 'search', category: null, query, ...input, path: '/search', limit: pageSize(sections, 'main-search') }) : Promise.resolve(null),
      loadSectionData(shop, [{ list: 'search', sections }]),
    ]);
    return {
      template: 'search',
      sections,
      data: { ...sectionData, listing: result },
      head: makeHead(headContext(shop), { title: query ? format(s.meta.searchTitle, { query }) : s.search.title, path: '/search', personal: true }),
    };
  });

export const getCartPage = createServerFn({ method: 'GET' }).handler(async (): Promise<TemplatePage> => {
  const shop = await shopRequest();
  await gate(shop, '/cart');
  const sections = shop.doc.templates.cart;
  const [cart, sectionData, shopper] = await Promise.all([currentCart(shop), loadSectionData(shop, [{ list: 'cart', sections }]), currentShopper(shop)]);
  const s = t(shop.site.locale);
  return {
    template: 'cart',
    sections,
    // A shop that hides prices from guests has no cart for them either.
    data: { ...sectionData, cart: buyingClosed(shop.doc.settings.access, shopper !== null) ? null : cart },
    head: makeHead(headContext(shop), { title: s.cart.title, path: '/cart', personal: true }),
  };
});

/** A content page (`/pages/<slug>`): the `page` template, whose `main-page` draws the page's own sections. */
export const getContentPage = createServerFn({ method: 'GET' })
  .validator(z.object({ slug: z.string().min(1).max(200) }))
  .handler(async ({ data: input }): Promise<TemplatePage> => {
    const shop = await shopRequest();
    const page = shop.doc.pages.find((candidate) => candidate.slug === input.slug);
    if (!page) throw notFound();
    const sections = shop.doc.templates.page;
    const sectionData = await loadSectionData(shop, [
      { list: 'page', sections },
      { list: 'content', sections: page.sections },
    ]);
    const path = `/pages/${encodeURIComponent(page.slug)}`;
    return {
      template: 'page',
      sections,
      data: { ...sectionData, page },
      head: makeHead(headContext(shop), { title: page.seoTitle?.trim() || page.title, description: page.seoDescription, path }),
    };
  });
