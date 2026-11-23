# storefront: WeldCommerce's online store renderer

Draws the shops merchants build in WeldCommerce's online store: the published
site version (or the draft, in the editor's preview) with the sections of
`@weldsuite/storefront-theme`, plus cart, checkout with Mollie or on invoice,
shopper accounts and B2B ordering. TanStack Start on Node (no Workers build),
EU and self-hosted editions only. AGPL-3.0-only.

The renderer is never reached directly. The WeldSuite server's **storefront
edge** resolves a shop host, handles redirects to the primary host, the
password and coming-soon pages and static deployments, and proxies every other
request (static files included) here with `X-Storefront-Edge`,
`X-Storefront-Host`, the site, workspace, channel and version ids and the
shopper's `X-Forwarded-*`. A request without the right `X-Storefront-Edge`
gets a 404 (`/healthz` excepted).

## Routes

| Route | |
|---|---|
| `/` | the `home` template |
| `/products`, `/categories/<slug>` | the `category` template (`main-category`): all products, or a category's; `?sort=`, `?cursor=` |
| `/products/<slug>` | the `product` template: variant picker, add to cart, JSON-LD Product and BreadcrumbList. An id in the URL redirects to the slug |
| `/search?q=` | the `search` template |
| `/cart` | the `cart` template |
| `/checkout` | email, addresses (with autofill tokens), shipping rate, VAT lines, terms checkbox (linking `/pages/terms` when the site has it), the EU withdrawal notice, pay with Mollie or on invoice (B2B) |
| `/checkout/return` | where Mollie sends the shopper back; the payment is read back through the API |
| `/orders/<id>?token=` | a guest's order (the channel's order link) |
| `/account` | sign in with an emailed code, then details, companies (B2B) and recent orders |
| `/account/orders`, `/account/orders/<id>` | order history, reorder |
| `/quick-order`, `/account/approvals` | B2B channels only |
| `/pages/<slug>` | a content page: the `page` template, whose `main-page` draws the page's own sections |
| anything else | the `notFound` template, status 404 |
| `/sitemap.xml`, `/robots.txt` | on the site's primary origin |
| `/__preview?token=` | sets the preview cookie and goes to `/` (see "Preview") |

Header and footer groups are on every page; menu links resolve to these paths
(`lib/menu-links.ts`). The site's own redirects (`document.redirects`) answer
with a 301 before any route.

`settings.access`: `prices_signed_in` hides prices and add to cart from guests;
`signed_in` sends guests to `/account` from every catalogue page (home,
products, categories, search, cart, checkout). Content pages stay public.

## How it talks to the server

- `GET {STOREFRONT_API_URL}/public/storefront/site?host=…[&preview=…]` with
  `Authorization: Bearer <STOREFRONT_RENDERER_SECRET>`: the site and its
  published document. The answer is kept per host for 30 seconds (or until
  the edge's `X-Storefront-Version` changes) and the document by version id;
  a draft is never kept.
- The storefront API (`/storefront/v1`) through `@weldsuite/commerce-sdk`, as
  the *hosted* principal: the client is made with the key `wcs_hosted` and a
  `fetch` that sends `Authorization: Hosted <secret>` and `X-Storefront-Host`
  instead (`lib/hosted-fetch.ts`), plus `X-Shopper-Ip` from the edge's
  `X-Forwarded-For`. The renderer holds no storefront keys.

All writes are server functions (`lib/server/actions`). Forms work without
page script too: the server function then answers with a 303 to the next page,
or back with `?error=CODE`.

Cookies, all on the shop host, httpOnly, `SameSite=Lax`, `Secure` when
`X-Forwarded-Proto` is https: `wsf_cart`, `wsf_session`, `wsf_checkout`,
`wsf_signin`; `wsf_preview` (`SameSite=None; Secure; Partitioned`); and
`wsf_consent`, the shopper's analytics choice (readable by page script).

## Preview

The platform's editor asks the server for a preview URL
(`https://<previewHost>/__preview?token=…`) and frames it. The renderer stores
the token in `wsf_preview`, asks for the site with `&preview=`, draws the draft
with `noindex`, marks every section with `data-section-id` and
`data-section-list`, and talks to the editor over `postMessage`
(`lib/preview.ts`, `components/preview-bridge.tsx`): it takes `refresh`,
`highlight` and `navigate` from origins in `STOREFRONT_EDITOR_ORIGINS` only, and
sends `ready` and `select`.

## Analytics and consent

Only when the site sets `settings.analytics.weldpanelProjectKey` (and an http(s)
`collectorUrl`): WeldPanel's script is loaded from the collector. With
`settings.cookieBanner`, nothing loads until the shopper allows it in the
banner; the choice can be changed from the link under the footer. Without the
banner the script runs cookieless.

## Configuration

| Variable | |
|---|---|
| `STOREFRONT_API_URL` | the WeldSuite server, e.g. `http://localhost:8789` |
| `STOREFRONT_RENDERER_SECRET` | shared with the server (and its edge) |
| `STOREFRONT_EDITOR_ORIGINS` | comma-separated platform origins allowed to drive previews, e.g. `http://localhost:3000` |
| `FORMS_PORTAL_URL` | WeldForms' portal, for contact form sections (optional) |
| `PORT`, `HOST` | for `node node/server.mjs` (default `3031`, `0.0.0.0`) |

## Running locally

Against `weldsuite serve` with its storefront edge on port 8791 (the server
reads `STOREFRONT_RENDERER_URL=http://localhost:3031` and the same
`STOREFRONT_RENDERER_SECRET`; shops are at `http://<slug>.shop.localhost:8791`):

```bash
export STOREFRONT_API_URL=http://localhost:8789
export STOREFRONT_RENDERER_SECRET=dev-renderer-secret   # the server's value
export STOREFRONT_EDITOR_ORIGINS=http://localhost:3000
pnpm --filter storefront dev                             # http://localhost:3031, through the edge only
# open http://<your shop's slug>.shop.localhost:8791
```

Browsing `localhost:3031` directly answers 404 by design. `*.localhost` names
resolve to your machine in current browsers; the preview cookie relies on
browsers treating `localhost` as a secure context.

## Building and testing

```bash
pnpm --filter storefront build        # = build:node: dist/client + dist/server/server.js, every dependency bundled
pnpm --filter storefront start:node   # node node/server.mjs (distroless-friendly: Node and dist/ only)
pnpm --filter storefront test         # edge check, hosted fetch, cookies, menu links, sitemap, site cache, …
pnpm --filter storefront type-check
pnpm --filter storefront lint
```
