import { isStorefrontError, type Cart, type StorefrontCategory, type StorefrontChannel } from '@weldsuite/commerce-sdk';
import { useEffect, useRef } from 'react';
import { Form, Link, NavLink, Outlet, ScrollRestoration, useLoaderData, useLocation } from 'react-router';

import { storefront } from '../lib/client';
import { text } from '../lib/messages';
import { clearCartToken, getCartToken } from '../lib/storage';
import { categoryPath } from '../lib/urls';

export interface RootData {
  channel: StorefrontChannel;
  categories: StorefrontCategory[];
  itemCount: number;
}

/** The shopper's open cart, or null (none, checked out or expired: then the token is dropped). */
export async function loadCart(): Promise<Cart | null> {
  const token = getCartToken();
  if (!token) return null;
  try {
    const cart = await storefront().cart.get(token);
    if (cart.status === 'open' || cart.status === 'checkout') return cart;
  } catch (error) {
    if (!isStorefrontError(error, 'CART_NOT_FOUND', 'CART_NOT_OPEN')) throw error;
  }
  clearCartToken();
  return null;
}

/** What every page needs: the channel (name, currency), the top categories, the cart count. */
export async function loader(): Promise<RootData> {
  const [channel, categories, cart] = await Promise.all([storefront().channel.get(), storefront().categories.list(), loadCart()]);
  return { channel, categories, itemCount: cart?.itemCount ?? 0 };
}

/** After a client-side navigation, move focus to the new page's heading so screen readers announce it. */
function useFocusOnNavigation() {
  const location = useLocation();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const heading = document.querySelector<HTMLElement>('main h1');
    if (!heading) return;
    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  }, [location.pathname]);
}

export function Layout() {
  const { channel, categories, itemCount } = useLoaderData() as RootData;
  useFocusOnNavigation();
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#main" className="sr-only z-50 rounded-lg bg-brand px-4 py-2 text-brand-ink focus:not-sr-only focus:fixed focus:left-4 focus:top-4">
        {text.skipToContent}
      </a>
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4">
          <Link to="/" className="text-xl font-bold tracking-tight">
            {channel.name}
          </Link>
          <search className="order-last w-full sm:order-none sm:w-auto sm:flex-1">
            <Form action="/products" method="get" className="flex gap-2">
              <label htmlFor="site-search" className="sr-only">
                {text.searchLabel}
              </label>
              <input id="site-search" type="search" name="search" placeholder={text.searchLabel} autoComplete="off" spellCheck={false} enterKeyHint="search" maxLength={100} className="w-full sm:max-w-sm" />
              <button type="submit" className="btn btn-secondary">
                {text.search}
              </button>
            </Form>
          </search>
          <nav aria-label={text.shopNav} className="ml-auto">
            <ul role="list" className="flex items-center gap-5">
              <li>
                <NavLink to="/cart" className="nav-link">
                  <span>{text.cart}</span>{' '}
                  <span className="inline-flex min-w-6 justify-center rounded-full bg-brand px-1.5 text-sm text-brand-ink">
                    {itemCount}
                    <span className="sr-only"> {itemCount === 1 ? 'item' : 'items'}</span>
                  </span>
                </NavLink>
              </li>
            </ul>
          </nav>
        </div>
        {categories.length > 0 ? (
          <nav aria-label={text.categoriesNav} className="border-t border-line">
            <ul role="list" className="mx-auto flex max-w-6xl gap-6 overflow-x-auto px-4 py-3 whitespace-nowrap">
              <li>
                <NavLink to="/products" end className="nav-link">
                  {text.allProducts}
                </NavLink>
              </li>
              {categories.map((category) => (
                <li key={category.id}>
                  <NavLink to={categoryPath(category.slug)} className="nav-link">
                    {category.name}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
      </header>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 focus:outline-none">
        <Outlet />
      </main>
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-1 px-4 py-6 text-sm text-ink-muted">
          <p>{text.pricesNote(channel.currency, channel.pricesIncludeTax)}</p>
          <p>{text.poweredBy}</p>
        </div>
      </footer>
      <ScrollRestoration />
    </div>
  );
}
