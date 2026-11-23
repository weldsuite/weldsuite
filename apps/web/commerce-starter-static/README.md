# WeldCommerce static starter shop

A shop that runs entirely in the browser on the WeldCommerce storefront API
(`@weldsuite/commerce-sdk`), built with Vite, React 19, React Router and
Tailwind CSS v4. Deploy it to WeldCommerce's own hosting with
`weld storefront deploy`, or to any static host. MIT licensed: fork it and
make it yours.

It has a home page, all products (with search and sorting), categories,
product pages with variants, a cart with discount codes, a checkout with
addresses, shipping and VAT that pays through Mollie, the page Mollie sends
shoppers back to (with "try again" for failed or expired payments), a guest
order page for the link in the confirmation email, and a 404.

## Configuration

Set at build time (copy `.env.example` to `.env.local`). Everything here ends
up in the browser bundle.

| Variable | |
|---|---|
| `VITE_WELDCOMMERCE_API_URL` | Your WeldSuite server, e.g. `https://api.weldsuite.eu` |
| `VITE_WELDCOMMERCE_KEY` | A **publishable** storefront key (`wcp_…`) of the sales channel (Settings → Apps → WeldCommerce → Channels → Keys). A private key (`wcs_…`) is refused: the build stops. |
| `VITE_SHOP_URL` | The shop's public address (`https://…`): Mollie sends shoppers back to `<VITE_SHOP_URL>/checkout/return`, confirmation emails link to `<VITE_SHOP_URL>/orders/{orderId}?token={token}`, and prerendered pages use it for canonical URLs |
| `VITE_SHOP_LOCALE` | Optional, how prices and dates look (default `en-IE`) |

A publishable key works from the channel's WeldSuite-hosted addresses
automatically, and from the origins listed on the key otherwise (add
`http://localhost:3032` for development). Mollie and the order links need an
https `VITE_SHOP_URL`.

## Develop

```bash
pnpm install
cp .env.example .env.local   # and fill it in
pnpm dev                     # http://localhost:3032
pnpm test                    # the helpers: prerender escaping, errors, storage, URLs
```

The cart token (`wct_…`) and the last checkout (order id, Mollie payment id
and a guest's order token) are kept in `localStorage`; when storage is blocked
they live in memory for the visit. Every sentence the shop shows is in
`src/lib/messages.ts` (English; translate that file to add a language).

## Build

```bash
pnpm build      # type-check, Vite build, then prerender into dist/
pnpm preview    # serve dist/ on http://localhost:3032
```

The last build step reads the catalogue through the SDK with the publishable
key (sending `Origin: VITE_SHOP_URL`, as a browser on the shop would) and
writes `dist/products/<slug>/index.html` and `dist/categories/<slug>/index.html`:
the app's page with a title, description, canonical URL, Open Graph tags,
JSON-LD (Product with offers, BreadcrumbList) and the product's text, so
search engines and link previews see real content. When the app starts it
takes over the page. If the API can't be reached at build time, prerendering
is skipped with a warning and the shop still works. At most 1,500 pages are
prerendered (a deployment holds 2,000 files); the rest render in the browser.
Rebuild and redeploy when the catalogue changes, for example from a
WeldConnect workflow or a channel webhook that starts your CI.

## Deploy with `weld storefront deploy`

In WeldSuite, set the channel's online store to **Host my own code**, give it
an address and create a **deploy key** (`wcd_…`) for the channel. Then:

```bash
export WELDCOMMERCE_API_URL=https://app.weldsuite.eu
export WELDCOMMERCE_DEPLOY_KEY=wcd_…   # a secret: keep it in your CI's secrets
weld storefront deploy                 # builds, uploads dist/, prints a preview address
weld storefront deploy --prod          # makes it the live shop
```

`weldstorefront.json` tells the hosting to answer every path without a file
with `index.html` (`spa`), to serve `/products/x` from
`products/x/index.html` (`cleanUrls`), and to cache the hashed files under
`/assets/` for a year.

From GitHub Actions:

```yaml
name: Deploy shop
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: npx -y @weldsuite/cli storefront deploy --prod
        env:
          WELDCOMMERCE_API_URL: https://app.weldsuite.eu
          WELDCOMMERCE_DEPLOY_KEY: ${{ secrets.WELDCOMMERCE_DEPLOY_KEY }}
          VITE_WELDCOMMERCE_API_URL: https://api.weldsuite.eu
          VITE_WELDCOMMERCE_KEY: ${{ vars.WELDCOMMERCE_PUBLISHABLE_KEY }}
          VITE_SHOP_URL: https://shop.example.com
```

## Static or server-rendered?

The server-rendered starter (`commerce-starter`, Next.js) keeps a private key
on its server, renders every page with live data, keeps tokens in httpOnly
cookies, and offers shopper sign-in, accounts and B2B ordering. It needs a
server to run on.

This static starter needs no server at all and holds **no private key
anywhere**: the browser talks to the storefront API with a publishable key,
which only works from the shop's own addresses. Search engines get prerendered
product and category pages; prices and stock on them are as of the last build,
while the app always shows live data. Tokens are in `localStorage` instead of
httpOnly cookies, so keep third-party scripts off the shop (a strict
`Content-Security-Policy` in `weldstorefront.json` helps). Shopper accounts and
B2B features are left out; a channel that requires signing in at checkout
needs the server-rendered starter.

## Licence

MIT, see [LICENSE](LICENSE).
