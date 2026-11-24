import { createBrowserRouter } from 'react-router';

import * as cart from './routes/cart';
import * as checkout from './routes/checkout';
import * as checkoutReturn from './routes/checkout-return';
import { NotFound, RootError, RouteError } from './routes/errors';
import * as home from './routes/home';
import * as listing from './routes/listing';
import * as order from './routes/order';
import * as product from './routes/product';
import * as root from './routes/root';

/**
 * Every page. Loaders read through the SDK in the browser; actions write
 * (cart, checkout). After any action the router reloads the page's loaders,
 * the header's cart count included.
 */
export function createRouter() {
  return createBrowserRouter([
    {
      id: 'root',
      path: '/',
      loader: root.loader,
      Component: root.Layout,
      ErrorBoundary: RootError,
      // Nothing to show while the first page loads: the prerendered HTML stays until then (main.tsx).
      HydrateFallback: () => null,
      children: [
        {
          // Errors of a page render inside the layout, under the header.
          ErrorBoundary: RouteError,
          children: [
            { index: true, loader: home.loader, Component: home.Component },
            { path: 'products', loader: listing.loader, Component: listing.Component },
            { path: 'categories/:slug', loader: listing.loader, Component: listing.Component },
            { path: 'products/:slug', loader: product.loader, action: product.action, Component: product.Component },
            { path: 'cart', loader: cart.loader, action: cart.action, Component: cart.Component },
            { path: 'checkout', loader: checkout.loader, action: checkout.action, Component: checkout.Component },
            { path: 'checkout/return', loader: checkoutReturn.loader, action: checkoutReturn.action, Component: checkoutReturn.Component },
            { path: 'orders/:id', loader: order.loader, Component: order.Component },
            { path: '*', Component: NotFound },
          ],
        },
      ],
    },
  ]);
}
