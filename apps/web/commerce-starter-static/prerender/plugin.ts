/**
 * The build's last step: prerender product and category pages into
 * dist/products/<slug>/index.html and dist/categories/<slug>/index.html.
 * The catalogue is read through the SDK with the publishable key, as a
 * browser on the shop's address would (`Origin: VITE_SHOP_URL`). When the
 * API can't be reached the build still succeeds, with a warning: the app
 * renders every page in the browser anyway.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createStorefrontClient, type FetchLike, type StorefrontCategory, type StorefrontProduct } from '@weldsuite/commerce-sdk';
import type { Plugin } from 'vite';

import { readConfig, type ShopConfig } from '../src/lib/config.ts';
import { categoryPage, productPage, renderIndex, renderPage, safeSlug, type PrerenderedPage, type ShopContext } from './html.ts';

/** A deployment holds at most 2,000 files; leave room for the app's own. */
export const MAX_PAGES = 1_500;
const TIMEOUT_MS = 15_000;

/** `fetch` that says which site is asking, as the browser would. */
export function withOrigin(origin: string, base: FetchLike = (input, init) => fetch(input, init)): FetchLike {
  return (input, init) => {
    const headers = new Headers(init.headers);
    headers.set('Origin', origin);
    return base(input, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS) });
  };
}

function flatten(categories: StorefrontCategory[]): StorefrontCategory[] {
  return categories.flatMap((category) => [category, ...flatten(category.children)]);
}

async function write(outDir: string, page: PrerenderedPage, template: string, shop: ShopContext): Promise<void> {
  const folder = join(outDir, ...page.path.split('/').filter(Boolean));
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'index.html'), renderPage(template, page, shop));
}

export async function prerenderShop(config: ShopConfig, outDir: string, log: (message: string) => void): Promise<number> {
  const client = createStorefrontClient({ baseUrl: config.apiUrl, key: config.key, fetch: withOrigin(config.shopUrl) });
  const channel = await client.channel.get();
  const shop: ShopContext = { shopUrl: config.shopUrl, shopName: channel.name, locale: config.locale };
  const template = await readFile(join(outDir, 'index.html'), 'utf8');
  await writeFile(join(outDir, 'index.html'), renderIndex(template, shop));

  const categories = flatten(await client.categories.list()).filter((category) => safeSlug(category.slug));
  const products: StorefrontProduct[] = [];
  for await (const product of client.products.iterate({ limit: 100 })) {
    if (safeSlug(product.slug)) products.push(product);
    if (products.length + categories.length >= MAX_PAGES) {
      log(`more than ${MAX_PAGES} pages: the rest are rendered in the browser only`);
      break;
    }
  }
  let written = 0;
  for (const category of categories) {
    const inCategory = products.filter((product) => product.categories.some((ref) => ref.id === category.id));
    await write(outDir, categoryPage(category, inCategory, shop), template, shop);
    written += 1;
  }
  for (const product of products) {
    await write(outDir, productPage(product, shop), template, shop);
    written += 1;
  }
  return written;
}

export function prerender(env: Record<string, string>): Plugin {
  let outDir = 'dist';
  let warn: (message: string) => void = () => undefined;
  let info: (message: string) => void = () => undefined;
  return {
    name: 'weldcommerce-prerender',
    apply: 'build',
    configResolved(resolved) {
      outDir = resolve(resolved.root, resolved.build.outDir);
      warn = (message) => resolved.logger.warn(`[prerender] ${message}`);
      info = (message) => resolved.logger.info(`[prerender] ${message}`);
    },
    async closeBundle() {
      const read = readConfig(env);
      if ('problem' in read) {
        warn(`skipped (${read.problem}): the shop's pages render in the browser only.`);
        return;
      }
      try {
        const count = await prerenderShop(read.config, outDir, warn);
        info(`${count} product and category pages written.`);
      } catch (error) {
        warn(`skipped, the API could not be read (${error instanceof Error ? error.message : String(error)}): the shop's pages render in the browser only.`);
      }
    },
  };
}
