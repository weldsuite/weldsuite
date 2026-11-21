# @weldsuite/commerce-sdk

A typed client for the WeldCommerce **storefront API**: the catalogue, carts
and checkout of a WeldCommerce sales channel, Mollie payments, shopper
sign-in and accounts, and B2B ordering (company buyers, approvals, quick
order, pay on invoice).

- No runtime dependencies: it only needs `fetch` (Node 18+, browsers, edge
  runtimes).
- No global state: cart and shopper tokens go in and come out, so one client
  serves every shopper of a server, and the same code runs in SSR and in the
  browser.
- Money stays a decimal string (`"19.99"`); helpers format it with
  `Intl.NumberFormat` without float maths.
- ESM with TypeScript types. MIT licensed.

A complete Next.js shop built on this SDK, ready to fork, lives in
[`apps/web/commerce-starter`](https://github.com/weldsuite/weldsuite/tree/main/apps/web/commerce-starter).

## Install

```bash
npm install @weldsuite/commerce-sdk
```

> The package is not on npm yet. Until it is, build it from this repository
> (`pnpm --filter @weldsuite/commerce-sdk build`) or use it from the
> monorepo's workspace.

## Keys

Create a **storefront channel** and its keys in WeldSuite, under
**Settings → Apps → WeldCommerce → Channels**. A key belongs to one channel;
the channel decides the currency, the countries you sell to, guest checkout
and the payment methods.

| Key | Prefix | Where it goes |
|---|---|---|
| Publishable | `wcp_…` | Browser code. Works only from the **allowed origins** you list on the key (e.g. `https://shop.example.com`); the API answers CORS for those origins and refuses others with `ORIGIN_NOT_ALLOWED`. |
| Private | `wcs_…` | Your server only. No origin check and no CORS. |

**Never ship a `wcs_` key to a browser**: anyone holding it can act as your
shop. The client refuses a private key when it runs in a browser. Keep it in
an environment variable on your server and rotate it in Settings if it ever
leaks (rotating revokes the old key at once).

## Quick start

On your server (Next.js server components and route handlers, Remix loaders,
an Express app, …):

```ts
import { createStorefrontClient } from '@weldsuite/commerce-sdk';

const storefront = createStorefrontClient({
  baseUrl: process.env.WELDCOMMERCE_API_URL!, // your WeldSuite API, e.g. https://api.weldsuite.eu
  key: process.env.WELDCOMMERCE_KEY!,         // wcs_…
});

const channel = await storefront.channel.get();
const { data: products, pagination } = await storefront.products.list({ sort: 'newest', limit: 12 });
const product = await storefront.products.get('linen-shirt'); // id or slug
const categories = await storefront.categories.list();       // a tree
```

With a private key the requests come from your server, so tell the API who
the shopper is; rate limits then count per shopper instead of per server:

```ts
await storefront.products.list({ search: 'shirt', shopperIp: request.ip });
await storefront.products.get('linen-shirt', { shopperIp: request.ip });
```

In the browser, use a publishable key from an allowed origin:

```ts
const storefront = createStorefrontClient({
  baseUrl: 'https://api.weldsuite.eu',
  key: 'wcp_…',
});
```

`baseUrl` is the address of your WeldSuite API: the hosted EU edition's, or
your self-hosted install's. The client adds `/storefront/v1`.

### Options

| Option | |
|---|---|
| `baseUrl` | Your WeldSuite API's address. |
| `key` | `wcp_…` or `wcs_…`. |
| `fetch` | Your own `fetch` (tests, proxies, a framework's caching `fetch`). |
| `shopperIp` | Sent as `X-Shopper-Ip` (private keys only). Usually passed per request instead. |
| `rateLimitRetries` | Retry a 429 this many times, waiting `Retry-After` each time. Default `0`. |
| `maxRetryAfter` | The longest wait (seconds) worth retrying for. Default `10`. |

Every method takes an options object last, with `signal` (to abort it) and
`shopperIp`. Where a call has optional fields of its own (`products.list`,
`cart.create`, `orders.list`, `auth.requestCode`, `approvals.approve`) they go
in that same object, so you never pass `undefined` to reach the options.

## Products and categories

```ts
// One page (≤ 100, default 24); filter by category id or slug, search, sort.
const page = await storefront.products.list({ category: 'shirts', search: 'linen', sort: 'price', limit: 24 });
const next = page.pagination.hasMore
  ? await storefront.products.list({ category: 'shirts', sort: 'price', cursor: page.pagination.cursor! })
  : null;

// Or every product, page after page:
for await (const product of storefront.products.iterate({ category: 'shirts' })) {
  console.log(product.name, product.price);
}
```

A cursor is opaque: pass back the one a page gave you, with the same `sort`.
One the list didn't give out (an edited link, another sort) is 400
`INVALID_CURSOR`; start again from the first page. Products that disappear
between pages don't throw paging off.

A product has `options` (e.g. `Size: S, M, L`) and `variants`, each with
`optionValues`, a `price` and `available`. A product without variants has an
empty `variants` list and is added to the cart by `productId`; a product with
variants needs a `variantId`.

```ts
const variant = product.variants.find((v) =>
  Object.entries(selected).every(([name, value]) => v.optionValues[name] === value),
);
```

## Cart and checkout

A cart is identified by its **cart token** (`wct_…`), returned once when you
create it. Store it (an httpOnly cookie on your server, or `localStorage` in a
browser-only shop) and send it with every cart call. Carts expire 30 days
after their last change.

```ts
const { cart, cartToken } = await storefront.cart.create({
  items: [{ variantId: variant.id, quantity: 1 }],
});

await storefront.cart.addItem(cartToken, { productId: 'prod_…', quantity: 2 }); // adds up if already there
await storefront.cart.updateItem(cartToken, lineId, 3);                         // 0 removes
await storefront.cart.removeItem(cartToken, lineId);
await storefront.cart.applyDiscount(cartToken, 'SUMMER10');
await storefront.cart.removeDiscount(cartToken);

const current = await storefront.cart.get(cartToken); // prices are worked out again on every read
```

Then the shopper's details. VAT is worked out once the shipping address is
known (`taxLines`, `taxTotal`, `vatTreatment`); the billing address defaults
to the shipping address.

```ts
let ready = await storefront.cart.update(cartToken, {
  email: 'ada@example.com',
  shippingAddress: {
    name: 'Ada Lovelace',
    line1: 'Oudegracht 1',
    postalCode: '3511 AA',
    city: 'Utrecht',
    country: 'NL',
  },
});

const rates = await storefront.cart.shippingRates(cartToken); // for the shipping country
ready = await storefront.cart.setShippingRate(cartToken, rates[0].id);

ready.ready;   // true when it can be checked out
ready.missing; // otherwise: 'items' | 'email' | 'shippingAddress' | 'shippingRate' | 'billingAddress'
```

### Checkout with Mollie

```ts
import { createIdempotencyKey } from '@weldsuite/commerce-sdk';

const idempotencyKey = createIdempotencyKey(); // keep it for retries of this attempt

const result = await storefront.cart.checkout(
  cartToken,
  {
    paymentMethod: 'mollie',
    expectedTotal: ready.total, // the total the shopper saw: PRICE_CHANGED instead of a surprise
    redirectUrl: 'https://shop.example.com/checkout/return',
    orderUrl: 'https://shop.example.com/orders/{orderId}?token={token}', // for the confirmation email
  },
  { idempotencyKey },
);

// result.order: the placed order (status pending until Mollie says paid)
// result.payment: { id, status, checkoutUrl }
// result.orderToken: a guest's order link token (wot_…, shown once); null when signed in
if (result.orderToken) keepForTheOrderPage(result.order.id, result.orderToken);
redirect(result.payment!.checkoutUrl!);
```

- **Idempotency.** Retrying a checkout with the same `idempotencyKey` (after
  a timeout, a double click) returns the first attempt's result instead of a
  second order (without `orderToken`: it is shown once). If the order was
  placed but Mollie could not start the payment, checkout fails with 502
  `PROVIDER_ERROR` (`details.orderId`); retrying with the same key tries the
  payment again.
- **`redirectUrl`** must be `https://`. With a publishable key its origin
  must be one of the key's allowed origins (`REDIRECT_NOT_ALLOWED`). Mollie
  sends the shopper back to it with `?order=<orderId>&payment=<paymentId>`
  added.
- **`orderUrl`** is the link in the confirmation email: `https://` with
  `{orderId}` and `{token}` (empty for a signed-in shopper). Another shape is
  400 `VALIDATION_ERROR`; a publishable key's origins apply
  (`ORDER_URL_NOT_ALLOWED`).

### The return page

Coming back from Mollie never marks anything paid by itself: the API reads
the payment back from Mollie (and Mollie's webhook settles it too). Read the
payment id from the return URL's `payment` parameter:

```ts
const paymentId = new URL(request.url).searchParams.get('payment')!;
const payment = await storefront.payments.get(paymentId); // 404 for a payment of another channel
switch (payment.status) {
  case 'paid':
  case 'authorized':
    // Thank you! payment.orderNumber
    break;
  case 'open':
  case 'pending':
    // Still waiting for Mollie: show a "checking your payment" message and read again in a moment.
    break;
  case 'failed':
  case 'canceled':
  case 'expired': {
    // Offer to try again: a new payment for the same order.
    const retry = await storefront.payments.retry(paymentId);
    redirect(retry.checkoutUrl!);
  }
}
```

An order paid by Mollie on a B2B channel that needs approval has no payment
yet (`result.payment` is `null`, `result.order.approvalStatus` is
`'pending'`): it gets one once an approver says yes, and the buyer is emailed
the link. Until then `payments.retry` is 409 `ORDER_NOT_PAYABLE`.

### Guest order links

A guest checkout returns `orderToken` (`wot_…`) once. With the order id it
opens the order without a session, e.g. on an order status page or from the
link in the confirmation email (`orderUrl`). Only a hash of the token is
stored; a wrong token is 404 `NOT_FOUND`.

```ts
const order = await storefront.orders.getGuest(orderId, orderToken);
```

## Shopper sign-in and accounts

Shoppers sign in with a 6-digit code sent by email; there are no passwords.
A session token (`wss_…`) comes back, valid for 30 days on this channel;
send it as `shopperToken`.

```ts
await storefront.auth.requestCode('ada@example.com', { locale: 'nl' }); // always { sent: true }: no account enumeration
const { sessionToken, expiresAt, shopper } = await storefront.auth.verify('ada@example.com', '123456');

const me = await storefront.account.get(sessionToken);
await storefront.account.update(sessionToken, { firstName: 'Ada', phone: '+31 6 12345678' });

const { data: orders, pagination } = await storefront.orders.list(sessionToken, { limit: 25 });
const order = await storefront.orders.get(sessionToken, orders[0].id);
const { cart, cartToken, problems } = await storefront.orders.reorder(sessionToken, order.id, { cartToken: existing });

await storefront.auth.signOut(sessionToken); // fine when the session has ended already
```

Every order has `approvalStatus` (`not_required` unless a B2B approval is
involved) and `placedBy` (`{ personId, name }`, `null` for a guest order).

Send the shopper token with cart calls too: a session on a cart attaches the
cart to the shopper (and, on a B2B channel, to their active company, and lets
them check out on channels without guest checkout). Leave it out for guests.

```ts
await storefront.cart.get(cartToken, { shopperToken: sessionToken });
```

**Sessions.** A route that needs a shopper answers 401 `SESSION_REQUIRED`
without a token. A token that is no longer good (expired, signed out, or from
another channel) is 401 `SESSION_EXPIRED` on any route, cart and checkout
included: forget it and treat the shopper as a guest (or ask them to sign in
again).

**Codes.** 5 requests per email per 15 minutes (429 `RATE_LIMITED`), 8
attempts per code, valid for 15 minutes. The email is in English or Dutch
(`locale: 'en' | 'nl'`). A wrong code is 401 `INVALID_CODE`
(`details.attemptsLeft`); an expired, used or never-requested code, or one
with 8 wrong guesses, is 410 `CODE_EXPIRED`: ask for a new one. When the
server can't send codes it answers 503 `SIGN_IN_UNAVAILABLE`.

## B2B

On a B2B channel prices exclude VAT (`pricesIncludeTax: false`) and checkout
needs a signed-in shopper buying for a company.

**Companies.** `shopper.companies` lists the companies the shopper buys for,
with their role (`buyer`, `approver`, `admin`) and spend limit. With more
than one, let them pick:

```ts
await storefront.account.selectCompany(sessionToken, companyId); // NOT_A_BUYER if they can't
```

Checkout without a signed-in buyer with an active company fails with 409
`COMPANY_REQUIRED` (403 `NOT_A_BUYER` when the shopper can't buy for it).
Add the buyer's VAT number (reverse charge, checked against VIES) and their
PO reference to the cart:

```ts
await storefront.cart.update(cartToken, { buyerVatNumber: 'NL123456789B01', customerReference: 'PO-2026-117' }, { shopperToken });
```

**Pay on invoice.** When the channel offers `invoice`:

```ts
const result = await storefront.cart.checkout(cartToken, { paymentMethod: 'invoice', expectedTotal: cart.total }, { shopperToken, idempotencyKey });
// result.payment is null; result.order.paymentStatus is 'on_invoice'
```

It needs payment terms on the company (`NO_PAYMENT_TERMS`) and room in its
credit limit (`CREDIT_LIMIT_EXCEEDED`, `details.available`). The invoice is
created in WeldBooks with the company's terms.

**Approvals.** An order above the buyer's spend limit or the company's
approval threshold is placed with `approvalStatus: 'pending'` and waits for
an approver. Approvers and admins of the active company see them (others get
403 `NOT_AN_APPROVER`):

```ts
const approvals = await storefront.approvals.list(sessionToken); // [{ order, reason, requestedBy }]
const approved = await storefront.approvals.approve(sessionToken, orderId, { comment: 'OK for Q4 budget' });
await storefront.approvals.reject(sessionToken, orderId, { comment: 'Too many chairs' });
```

Approving an invoice order confirms it. Approving a Mollie order starts its
payment: `approved.payment` is `{ id, status, checkoutUrl }`, and the buyer is
emailed the link. Rejecting cancels the order. An order decided already is
409 `NOT_PENDING`.

**Quick order.** Add lines by SKU, or paste a `sku,quantity` CSV (`;` or a
tab work too, header optional; up to 500 rows in all, more is 400
`VALIDATION_ERROR`). SKUs match exactly but case-insensitively, variants
first; with both, `lines` come before the CSV. Every line that can be added
is; the others come back as `problems` with their `row` (the position in
`lines`, or the CSV line number, header included). An `OUT_OF_STOCK` line is
added *and* reported, so the shopper knows there are fewer on hand; a row
without a SKU is `UNKNOWN_SKU`. Reorder reports the same way, with `row: null`.

```ts
const { cart, cartToken: created, problems } = await storefront.cart.quickOrder(
  { csv: 'sku,quantity\nCHAIR-01,12\nDESK-02,3' },
  { cartToken, shopperToken: sessionToken }, // without cartToken a new cart is made and its token returned
);
```

**Buyers** (company admins; others get 403 `NOT_AN_ADMIN`). The answers are
`Buyer`s; a spend limit is in the channel's currency.

```ts
await storefront.buyers.list(sessionToken);
await storefront.buyers.invite(sessionToken, { email: 'piet@acme.example', role: 'buyer', spendLimit: '500.00' }); // BUYER_EXISTS
await storefront.buyers.update(sessionToken, buyerId, { role: 'approver' });
await storefront.buyers.remove(sessionToken, buyerId); // LAST_ADMIN for the last admin
```

## Money

```ts
import { formatMoney, compareMoney, toMinorUnits, formatTaxRate } from '@weldsuite/commerce-sdk';

formatMoney('1234.5', 'EUR', { locale: 'nl-NL' }); // "€ 1.234,50"
formatMoney(cart.total, cart.currency, { locale: 'en-IE' }); // "€24.95"
compareMoney('9.50', '10.00');                     // -1
toMinorUnits('19.99');                             // 1999n (bigint)
formatTaxRate('21.00', 'en');                      // "21%"
```

`cart.pricesIncludeTax` says whether line prices include VAT; show
`taxTotal` (and `taxLines` per rate) either way.

## Errors

Every refusal throws a `StorefrontError` with `status`, `code`, `message`,
`details` and `retryAfter`:

```ts
import { isStorefrontError } from '@weldsuite/commerce-sdk';

try {
  await storefront.cart.checkout(cartToken, { paymentMethod: 'mollie', expectedTotal, redirectUrl }, { idempotencyKey });
} catch (error) {
  if (isStorefrontError(error, 'PRICE_CHANGED')) {
    // details.total: show the new total and ask again
  } else if (isStorefrontError(error, 'OUT_OF_STOCK')) {
    // details.lines: [{ lineId, available }]
  } else if (isStorefrontError(error, 'CART_NOT_READY')) {
    // details.missing
  } else throw error;
}
```

`isStorefrontError(error, ...codes)` narrows `details` to the documented
shape. Validation failures are 400 `VALIDATION_ERROR` with
`details.fields` (`{ "shippingAddress.country": "Must be a 2-letter country code" }`).

| Code | Status | When |
|---|---|---|
| `INVALID_KEY` | 401 | Missing, unknown or revoked key |
| `ORIGIN_NOT_ALLOWED` | 403 | A publishable key used from an origin it doesn't allow |
| `CHANNEL_INACTIVE` | 403 | The channel isn't active (or the shop is suspended) |
| `RATE_LIMITED` | 429 | Too many requests; `retryAfter` says how long to wait |
| `WORKSPACE_MOVING` | 503 | The shop is being moved; `retryAfter` (30 s) |
| `VALIDATION_ERROR` | 400 | A field is wrong: `details.fields` |
| `NOT_FOUND` | 404 | No such product, category, order, payment or buyer on this channel (also a wrong guest order token) |
| `INVALID_CURSOR` | 400 | A cursor the list didn't give out, or one of another sort: start from the first page |
| `SESSION_REQUIRED` | 401 | The route needs a signed-in shopper: send `shopperToken` |
| `SESSION_EXPIRED` | 401 | The shopper token is expired, signed out or from another channel: drop it |
| `CART_NOT_FOUND` | 404 | Missing, unknown or someone else's cart token |
| `CART_NOT_OPEN` | 409 | The cart was checked out or expired: `details.status`. Start a new cart |
| `CART_TOO_LARGE` | 409 | More than 100 lines |
| `NOT_SELLABLE` | 409 | The product has no price on this channel or is inactive |
| `COUNTRY_NOT_SOLD` | 409 | The channel doesn't ship there: `details.country` |
| `RATE_NOT_AVAILABLE` | 409 | That shipping rate doesn't cover the cart's country |
| `DISCOUNT_NOT_APPLICABLE` | 409 | `details.reason`: `NOT_FOUND`, `EXPIRED`, `MINIMUM_SUBTOTAL`, … |
| `TAX_ENGINE_UNAVAILABLE` | 503 | VAT couldn't be calculated just now; try again |
| `SELLER_ENTITY_REQUIRED` | 409 | The shop isn't set up to sell yet |
| `CART_NOT_READY` | 409 | `details.missing`, `details.lines` |
| `OUT_OF_STOCK` | 409 | `details.lines`: `[{ lineId, available }]` |
| `PRICE_CHANGED` | 409 | The total differs from `expectedTotal`: `details.total` |
| `PAYMENT_METHOD_NOT_ENABLED` | 409 | The channel doesn't offer that method |
| `GUEST_CHECKOUT_DISABLED` | 409 | Sign the shopper in first |
| `IDEMPOTENCY_KEY_REUSED` | 409 | The key belongs to another cart |
| `PAYMENT_PROVIDER_NOT_CONNECTED` | 409 | The shop hasn't connected Mollie |
| `PAYMENTS_UNAVAILABLE` | 503 | The server can't reach payments right now |
| `REDIRECT_NOT_ALLOWED` | 400 | `redirectUrl` isn't on the key's allowed origins |
| `ORDER_URL_NOT_ALLOWED` | 400 | `orderUrl` isn't on the key's allowed origins |
| `PROVIDER_ERROR` | 502 | Mollie refused; the order exists: `details.orderId`. Retry with the same key |
| `COMPANY_REQUIRED` | 409 | B2B checkout without a signed-in buyer with an active company |
| `NO_PAYMENT_TERMS` | 409 | Pay on invoice without payment terms on the company |
| `CREDIT_LIMIT_EXCEEDED` | 409 | Over the company's credit limit: `details.available` |
| `ALREADY_PAID` | 409 | Retrying a payment for a paid order |
| `ORDER_NOT_PAYABLE` | 409 | The order can't be paid now (cancelled, on invoice, waiting for approval) |
| `PAYMENT_IN_PROGRESS` | 409 | The order has a payment in progress |
| `APPROVAL_PENDING` | 409 | The order waits for approval |
| `SIGN_IN_UNAVAILABLE` | 503 | Sign-in codes can't be sent right now; try again shortly |
| `INVALID_CODE` | 401 | Wrong sign-in code: `details.attemptsLeft` |
| `CODE_EXPIRED` | 410 | Expired, used, never requested or guessed wrong 8 times: request a new code |
| `NOT_A_BUYER` | 403 | The shopper can't buy for that company |
| `NOT_AN_APPROVER` | 403 | Only approvers and admins decide approvals |
| `NOT_AN_ADMIN` | 403 | Only company admins manage buyers |
| `NOT_PENDING` | 409 | The approval was already decided |
| `BUYER_EXISTS` | 409 | That person is a buyer of the company already |
| `LAST_ADMIN` | 409 | A company keeps at least one admin |
| `NETWORK_ERROR` | 0 | Raised by the SDK: the API couldn't be reached (`cause` has the reason) |
| `UNEXPECTED_RESPONSE` | any | Raised by the SDK: the answer wasn't the API's JSON |

A newer server may add codes; `error.code` is typed to allow them.

## Rate limits

Per key and client address, per minute:

| Requests | Limit |
|---|---|
| Reads (`GET`) | 120 |
| Cart writes | 60 |
| Checkouts | 10 |

Over the limit the API answers 429 `RATE_LIMITED` with `Retry-After`. With a
publishable key the client address is the shopper's browser. With a private
key it is your server, unless you send `shopperIp`: do, or all your shoppers
share one budget. `rateLimitRetries` makes the client wait and retry for you;
by default it throws so you can decide.

## Licence

MIT
