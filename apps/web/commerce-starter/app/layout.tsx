import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { NavLink } from '@/components/nav-link';
import { isConfigured } from '@/lib/commerce';
import { getCart, getCategories, getChannel, getShopper } from '@/lib/data';

import './globals.css';

// Every page reads the shopper's cookies and the live catalogue.
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  if (!isConfigured()) return { title: 'Shop' };
  const channel = await getChannel().catch(() => null);
  const name = channel?.name ?? 'Shop';
  return { title: { default: name, template: `%s · ${name}` } };
}

function SetupNotice() {
  return (
    <main id="main" className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-16">
      <h1 className="text-3xl font-semibold">Almost there</h1>
      <p>
        Connect this shop to WeldCommerce: copy <code>.env.example</code> to <code>.env.local</code> and set{' '}
        <code>WELDCOMMERCE_API_URL</code> and <code>WELDCOMMERCE_KEY</code> (a private storefront key from Settings → Apps →
        WeldCommerce → Channels). Then restart the server.
      </p>
    </main>
  );
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  if (!isConfigured()) {
    return (
      <html lang="en">
        <body>
          <SetupNotice />
        </body>
      </html>
    );
  }

  const [channel, categories, cart, shopper] = await Promise.all([getChannel(), getCategories(), getCart(), getShopper()]);
  const b2b = channel.audience === 'b2b';
  const itemCount = cart?.itemCount ?? 0;

  return (
    <html lang="en">
      <body className="flex min-h-dvh flex-col">
        <a
          href="#main"
          className="sr-only z-50 rounded-lg bg-brand px-4 py-2 text-brand-ink focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
        >
          Skip to content
        </a>
        <header className="border-b border-line">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4">
            <Link href="/" className="text-xl font-bold tracking-tight">
              {channel.name}
            </Link>
            <search className="order-last w-full sm:order-none sm:w-auto sm:flex-1">
              <form action="/products" method="get" className="flex gap-2">
                <label htmlFor="site-search" className="sr-only">
                  Search products
                </label>
                <input
                  id="site-search"
                  type="search"
                  name="search"
                  placeholder="Search products"
                  autoComplete="off"
                  spellCheck={false}
                  enterKeyHint="search"
                  maxLength={100}
                  className="w-full sm:max-w-sm"
                />
                <button type="submit" className="btn btn-secondary">
                  Search
                </button>
              </form>
            </search>
            <nav aria-label="Your shop" className="ml-auto">
              <ul role="list" className="flex items-center gap-5">
                {b2b ? (
                  <li>
                    <NavLink href="/quick-order">Quick order</NavLink>
                  </li>
                ) : null}
                <li>
                  <NavLink href="/account">{shopper ? 'Account' : 'Sign in'}</NavLink>
                </li>
                <li>
                  <NavLink href="/cart">
                    Cart
                    <span className="ml-1 inline-flex min-w-6 justify-center rounded-full bg-brand px-1.5 text-sm text-brand-ink">
                      {itemCount}
                      <span className="sr-only">{itemCount === 1 ? ' item' : ' items'}</span>
                    </span>
                  </NavLink>
                </li>
              </ul>
            </nav>
          </div>
          {categories.length > 0 ? (
            <nav aria-label="Categories" className="border-t border-line">
              <ul role="list" className="mx-auto flex max-w-6xl gap-6 overflow-x-auto px-4 py-3 whitespace-nowrap">
                <li>
                  <NavLink href="/products" exact>All products</NavLink>
                </li>
                {categories.map((category) => (
                  <li key={category.id}>
                    <NavLink href={`/categories/${encodeURIComponent(category.slug)}`}>{category.name}</NavLink>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
        </header>

        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 focus:outline-none">
          {children}
        </main>

        <footer className="border-t border-line">
          <div className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-6 text-sm text-ink-muted">
            <p>
              Prices are in {channel.currency} and {channel.pricesIncludeTax ? 'include' : 'exclude'} VAT.
            </p>
            <p>Powered by WeldCommerce.</p>
          </div>
        </footer>
      </body>
    </html>
  );
}
