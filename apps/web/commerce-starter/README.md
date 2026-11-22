# WeldCommerce starter shop

A small, complete shop on the WeldCommerce storefront API, built with
Next.js (App Router), React 19 and Tailwind CSS v4, using only
[`@weldsuite/commerce-sdk`](https://github.com/weldsuite/weldsuite/tree/main/packages/sdk/commerce-sdk). Fork it and
make it yours. MIT licensed.

What it does:

- **Catalogue**: categories, product list with search, sort and paging,
  product pages with a variant picker.
- **Cart**: quantities, discount codes, totals with VAT. The cart token sits
  in an httpOnly cookie.
- **Checkout**: email and addresses (with autofill), shipping method, VAT per
  rate, payment with Mollie (and the page Mollie sends the shopper back to),
  pay on invoice for B2B.
- **Accounts**: sign in with a code sent by email, order history, order
  pages, reorder.
- **B2B**: company choice, quick order (paste SKUs or upload a CSV), approvals
  for approvers.

Everything that talks to WeldCommerce runs on the server (server components
and server actions) with a **private key**: no key or token ever reaches the
browser.

## Run it against your WeldCommerce workspace

1. In WeldSuite, open **Settings → Apps → WeldCommerce → Channels** and create
   a **storefront** channel: its currency, the countries you sell to, guest
   checkout, and the payment methods (connect Mollie under **Payments** to take
   online payments). Make it **active**.
2. Give your products a price in the channel's currency.
3. On the channel, open **Keys** and create a **private** key (`wcs_…`). Copy
   it: it is shown once.
4. Copy `.env.example` to `.env.local` and fill it in:

   ```bash
   WELDCOMMERCE_API_URL=https://api.weldsuite.example   # your WeldSuite API address
   WELDCOMMERCE_KEY=wcs_…                               # the private key
   SHOP_URL=https://shop.example.com                    # where this shop runs (https)
   ```

   Never prefix the key with `NEXT_PUBLIC_`: that would ship it to browsers.

5. Install and start:

   ```bash
   # inside the WeldSuite monorepo
   pnpm install
   pnpm --filter commerce-starter dev        # http://localhost:3030

   # in your own fork
   npm install
   npm run dev
   ```

**Mollie needs https.** Mollie only sends shoppers back to an `https://`
address, and the order links in confirmation emails use `SHOP_URL`. To pay
with Mollie in development, run the shop behind an https tunnel and set
`SHOP_URL` to the tunnel's address. Use your Mollie test mode.

## Forking it outside the monorepo

The shop imports nothing from WeldSuite but the SDK. In your copy:

- replace `"@weldsuite/commerce-sdk": "workspace:*"` in `package.json` with
  the published version (`"^0.1.0"` once it is on npm);
- `transpilePackages` in `next.config.ts` can stay or go;
- deploy it anywhere Next.js runs (Vercel, a Node server, a container). It
  needs the three environment variables above.

## How it is put together

| Folder | |
|---|---|
| `lib/commerce.ts` | The SDK client (server-only), the shopper's IP for rate limits, the shop's URL |
| `lib/session.ts` | The httpOnly cookies: cart token, shopper session, last checkout |
| `lib/data.ts` | Per-request reads: channel, categories, cart, signed-in shopper |
| `lib/actions/` | Server actions: cart, checkout, sign-in, account, approvals, quick order |
| `lib/errors.ts` | The API's error codes as sentences for shoppers |
| `app/` | The pages |
| `components/` | Forms and building blocks (no UI library: plain Tailwind) |

Forms post to server actions and work before JavaScript has loaded; with
JavaScript they update in place.

The rate limits of the storefront API count per key and client address. With
a private key every request comes from this server, so the shop sends the
shopper's address (`X-Shopper-Ip`, from `x-real-ip` / `x-forwarded-for`). If
you run it behind your own proxy, check `requestOptions()` in
`lib/commerce.ts` reads the header your proxy sets.

## Make it yours

- **Look**: the colours are tokens at the top of `app/globals.css` (light and
  dark).
- **Language**: the text is English only. Add translations (for example with
  `next-intl`) and set `SHOP_LOCALE` for prices and dates.
- **Product descriptions** are shown as plain text. If yours are HTML,
  sanitise them before rendering.
- **Company buyers**: the SDK has `buyers.list/invite/update/remove` for
  company admins; this shop doesn't have pages for them yet.

## Scripts

`dev`, `build`, `start`, `lint`, `type-check`.
