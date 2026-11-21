import { StorefrontError, parseRetryAfter } from './errors.ts';
import type {
  Approval,
  Buyer,
  Cart,
  CartItemInput,
  CartWithProblems,
  CheckoutInput,
  CheckoutPayment,
  CheckoutResult,
  CreateCartInput,
  CreatedCart,
  DecidedOrder,
  InviteBuyerInput,
  ListOrdersParams,
  ListProductsParams,
  Page,
  PaymentInfo,
  QuickOrderInput,
  RequestCodeInput,
  ShippingRateOffer,
  Shopper,
  ShopperSession,
  StorefrontCategory,
  StorefrontChannel,
  StorefrontOrder,
  StorefrontProduct,
  UpdateAccountInput,
  UpdateBuyerInput,
  UpdateCartInput,
} from './types.ts';

/** The `fetch` the client calls: the global one, or yours (for tests, proxies, caching). */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface StorefrontClientOptions {
  /**
   * Your WeldSuite server's address, e.g. `https://api.weldsuite.eu`. The
   * client adds `/storefront/v1`; a URL that already ends in it works too.
   */
  baseUrl: string;
  /**
   * A storefront key: `wcp_…` (publishable, for browser code; works only
   * from the key's allowed origins) or `wcs_…` (private, for your server
   * only).
   */
  key: string;
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /**
   * The shopper's IP address, sent as `X-Shopper-Ip` so rate limits count
   * per shopper rather than per server. Private keys only. Usually set per
   * request (`RequestOptions.shopperIp`) instead.
   */
  shopperIp?: string;
  /**
   * How many times to retry a request the server refused with 429
   * `RATE_LIMITED`, waiting `Retry-After` seconds each time. Default 0: the
   * error is thrown and you decide.
   */
  rateLimitRetries?: number;
  /** The longest `Retry-After` (seconds) worth waiting for when retrying. Default 10. */
  maxRetryAfter?: number;
  /**
   * The client refuses a private key (`wcs_…`) when it runs in a browser.
   * Set this only for tooling that runs in a browser-like environment but
   * never ships to shoppers.
   */
  allowPrivateKeyInBrowser?: boolean;
}

/** Options every call takes. */
export interface RequestOptions {
  /** Abort the request. */
  signal?: AbortSignal;
  /** The shopper's IP for this request (private keys only); overrides the client's. */
  shopperIp?: string;
}

/** Options of calls a signed-in shopper may make. */
export interface ShopperOptions extends RequestOptions {
  /**
   * The shopper's session token (`wss_…`, from `auth.verify`). On a cart
   * call it attaches the cart to the shopper (and, on a B2B channel, to
   * their active company). Leave it out for a guest; a token that is no
   * longer valid on this channel is 401 `SESSION_EXPIRED`.
   */
  shopperToken?: string;
}

/** `products.list` and `products.iterate`: the filters, and the request options. */
export interface ListProductsOptions extends ListProductsParams, RequestOptions {}

/** `orders.list` and `orders.iterate`: the page, and the request options. */
export interface ListOrdersOptions extends ListOrdersParams, RequestOptions {}

/** `cart.create`: the first lines and email, and the shopper's session. */
export interface CreateCartOptions extends CreateCartInput, ShopperOptions {}

/** `auth.requestCode`: the email's language, and the request options. */
export interface RequestCodeOptions extends RequestCodeInput, RequestOptions {}

/** `approvals.approve` and `approvals.reject`. */
export interface DecisionOptions extends RequestOptions {
  /** Why (at most 2000 characters); the buyer sees it. */
  comment?: string;
}

export interface CheckoutOptions extends ShopperOptions {
  /**
   * Send the same key when you retry a checkout (a timeout, a double
   * click): the server returns the first attempt's result instead of
   * placing a second order. `createIdempotencyKey()` makes one.
   */
  idempotencyKey?: string;
}

export interface CartTokenOptions extends ShopperOptions {
  /** Add to this cart; without it a new cart is made and its token returned. */
  cartToken?: string;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface Call {
  method: Method;
  path: string;
  query?: Record<string, string | number | undefined | null>;
  body?: unknown;
  cartToken?: string;
  shopperToken?: string;
  idempotencyKey?: string;
  options?: RequestOptions;
}

interface Envelope<T> {
  data: T;
  pagination?: Page<unknown>['pagination'];
}

const API_PATH = '/storefront/v1';

function withoutTrailingSlashes(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === '/') end -= 1;
  return text.slice(0, end);
}

function apiRoot(baseUrl: string): string {
  let root = withoutTrailingSlashes(baseUrl.trim());
  if (root.endsWith(API_PATH)) root = root.slice(0, -API_PATH.length);
  if (!/^https?:\/\//i.test(root)) {
    throw new TypeError('baseUrl must be an absolute http(s) URL, e.g. https://api.weldsuite.eu');
  }
  return root + API_PATH;
}

function segment(value: string, name: string): string {
  if (typeof value !== 'string' || value === '') throw new TypeError(`${name} is required`);
  return encodeURIComponent(value);
}

function requireToken(value: string | undefined, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} is required`);
  return value;
}

function isAbort(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    ((error as { name: unknown }).name === 'AbortError' || (error as { name: unknown }).name === 'TimeoutError')
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The `{ data, pagination? }` of an answer, or a `StorefrontError` for a refusal; `undefined` for a 204. */
async function readEnvelope<T>(response: Response): Promise<Envelope<T> | undefined> {
  const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
  if (response.status === 204) return undefined;
  const text = await response.text();
  let body: unknown;
  try {
    body = text === '' ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const error = (body as { error?: { code?: unknown; message?: unknown; details?: unknown } } | undefined)?.error;
    if (error && typeof error.code === 'string') {
      throw new StorefrontError({
        status: response.status,
        code: error.code,
        message: typeof error.message === 'string' ? error.message : error.code,
        details: error.details,
        retryAfter,
      });
    }
    throw new StorefrontError({
      status: response.status,
      code: 'UNEXPECTED_RESPONSE',
      message: `The storefront API answered ${response.status} without an error body`,
      retryAfter,
    });
  }
  if (body === undefined || typeof body !== 'object' || body === null || !('data' in body)) {
    throw new StorefrontError({
      status: response.status,
      code: 'UNEXPECTED_RESPONSE',
      message: 'The storefront API answered without a data field',
    });
  }
  return body as Envelope<T>;
}

/** Yields every item of a cursor-paginated list, fetching pages as it goes. */
export async function* paginate<T>(
  load: (cursor: string | undefined) => Promise<Page<T>>,
  cursor?: string,
): AsyncGenerator<T, void, undefined> {
  let next = cursor;
  for (;;) {
    const page = await load(next);
    yield* page.data;
    if (!page.pagination.hasMore || !page.pagination.cursor) return;
    next = page.pagination.cursor;
  }
}

/** A random key for `CheckoutOptions.idempotencyKey`. */
export function createIdempotencyKey(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface StorefrontClient {
  /** The channel the key belongs to: its currency, countries, payment methods. */
  readonly channel: {
    get(options?: RequestOptions): Promise<StorefrontChannel>;
  };
  readonly products: {
    /** One page of the channel's products. */
    list(options?: ListProductsOptions): Promise<Page<StorefrontProduct>>;
    /** Every product matching the filters, page after page: `for await (const p of client.products.iterate())`. */
    iterate(options?: ListProductsOptions): AsyncGenerator<StorefrontProduct, void, undefined>;
    /** A product by id or slug. 404 `NOT_FOUND` when it is not sold on the channel. */
    get(idOrSlug: string, options?: RequestOptions): Promise<StorefrontProduct>;
  };
  readonly categories: {
    /** The active categories, as a tree. */
    list(options?: RequestOptions): Promise<StorefrontCategory[]>;
    /** A category (with its children) by id or slug. */
    get(idOrSlug: string, options?: RequestOptions): Promise<StorefrontCategory>;
  };
  readonly cart: {
    /** A new cart, and its token (shown once). */
    create(options?: CreateCartOptions): Promise<CreatedCart>;
    /** The cart, with prices worked out again. */
    get(cartToken: string, options?: ShopperOptions): Promise<Cart>;
    /** Add a line; adding a product or variant that is already in the cart raises its quantity. */
    addItem(cartToken: string, item: CartItemInput, options?: ShopperOptions): Promise<Cart>;
    /** Set a line's quantity; 0 removes it. */
    updateItem(cartToken: string, lineId: string, quantity: number, options?: ShopperOptions): Promise<Cart>;
    removeItem(cartToken: string, lineId: string, options?: ShopperOptions): Promise<Cart>;
    /** Email, addresses, VAT number, reference, note. VAT is worked out again. */
    update(cartToken: string, input: UpdateCartInput, options?: ShopperOptions): Promise<Cart>;
    /** The rates for the cart's shipping country (empty until it has one). */
    shippingRates(cartToken: string, options?: ShopperOptions): Promise<ShippingRateOffer[]>;
    setShippingRate(cartToken: string, shippingRateId: string, options?: ShopperOptions): Promise<Cart>;
    applyDiscount(cartToken: string, code: string, options?: ShopperOptions): Promise<Cart>;
    removeDiscount(cartToken: string, options?: ShopperOptions): Promise<Cart>;
    /** Place the order. With Mollie, send the shopper to `payment.checkoutUrl`. */
    checkout(cartToken: string, input: CheckoutInput, options?: CheckoutOptions): Promise<CheckoutResult>;
    /** Add lines by SKU (or a `sku,quantity` CSV); unknown or unsellable lines come back as `problems`. */
    quickOrder(input: QuickOrderInput, options?: CartTokenOptions): Promise<CartWithProblems>;
  };
  readonly payments: {
    /** A payment for the shop's return page; read back from Mollie while still open. */
    get(paymentId: string, options?: RequestOptions): Promise<PaymentInfo>;
    /** A new payment for an unpaid order (after `failed`, `expired` or `canceled`). */
    retry(paymentId: string, options?: RequestOptions): Promise<CheckoutPayment>;
  };
  readonly auth: {
    /**
     * Email the shopper a 6-digit sign-in code. Always answers `{ sent: true }`
     * (no account enumeration); 429 `RATE_LIMITED`, 503 `SIGN_IN_UNAVAILABLE`.
     */
    requestCode(email: string, options?: RequestCodeOptions): Promise<{ sent: boolean }>;
    /**
     * Exchange the code for a shopper session (on this channel only). 401
     * `INVALID_CODE`, 410 `CODE_EXPIRED`, 429 `RATE_LIMITED`.
     */
    verify(email: string, code: string, options?: RequestOptions): Promise<ShopperSession>;
    /** End the session; succeeds when it has ended already too. */
    signOut(shopperToken: string, options?: RequestOptions): Promise<void>;
  };
  readonly account: {
    get(shopperToken: string, options?: RequestOptions): Promise<Shopper>;
    update(shopperToken: string, input: UpdateAccountInput, options?: RequestOptions): Promise<Shopper>;
    /** B2B: the company the shopper buys for (`null` for none). */
    selectCompany(shopperToken: string, companyId: string | null, options?: RequestOptions): Promise<Shopper>;
  };
  readonly orders: {
    /** The shopper's orders on this channel, newest first (an approver or admin also sees the active company's). */
    list(shopperToken: string, options?: ListOrdersOptions): Promise<Page<StorefrontOrder>>;
    iterate(shopperToken: string, options?: ListOrdersOptions): AsyncGenerator<StorefrontOrder, void, undefined>;
    get(shopperToken: string, orderId: string, options?: RequestOptions): Promise<StorefrontOrder>;
    /**
     * A guest's order, with the `orderToken` checkout returned. No session
     * needed. A wrong or unknown token is 404 `NOT_FOUND`.
     */
    getGuest(orderId: string, orderToken: string, options?: RequestOptions): Promise<StorefrontOrder>;
    /** Put an order's lines in a cart again. */
    reorder(shopperToken: string, orderId: string, options?: Omit<CartTokenOptions, 'shopperToken'>): Promise<CartWithProblems>;
  };
  readonly approvals: {
    /** Orders waiting for the active company's approval (approvers and admins; others get 403 `NOT_AN_APPROVER`). */
    list(shopperToken: string, options?: RequestOptions): Promise<Approval[]>;
    /**
     * Approve a pending order: an invoice order is confirmed, a Mollie order
     * gets its payment (`payment` on the answer). 403 `NOT_AN_APPROVER`,
     * 409 `NOT_PENDING`.
     */
    approve(shopperToken: string, orderId: string, options?: DecisionOptions): Promise<DecidedOrder>;
    /** Reject a pending order: it is cancelled. 403 `NOT_AN_APPROVER`, 409 `NOT_PENDING`. */
    reject(shopperToken: string, orderId: string, options?: DecisionOptions): Promise<DecidedOrder>;
  };
  readonly buyers: {
    /** The active company's buyers (admins; others get 403 `NOT_AN_ADMIN`). */
    list(shopperToken: string, options?: RequestOptions): Promise<Buyer[]>;
    /** Add a buyer to the company and email them an invitation. 409 `BUYER_EXISTS`. */
    invite(shopperToken: string, input: InviteBuyerInput, options?: RequestOptions): Promise<Buyer>;
    /** 409 `LAST_ADMIN` when it would leave the company without an admin. */
    update(shopperToken: string, buyerId: string, input: UpdateBuyerInput, options?: RequestOptions): Promise<Buyer>;
    /** 409 `LAST_ADMIN` for the company's last admin. */
    remove(shopperToken: string, buyerId: string, options?: RequestOptions): Promise<void>;
  };
}

/**
 * A client for one storefront key. It keeps no state between calls: cart
 * and shopper tokens go in and come out, so one client can serve every
 * shopper of a server, and the same code runs in SSR and the browser.
 */
export function createStorefrontClient(options: StorefrontClientOptions): StorefrontClient {
  const root = apiRoot(options.baseUrl);
  const key = typeof options.key === 'string' ? options.key.trim() : '';
  if (!key.startsWith('wcp_') && !key.startsWith('wcs_')) {
    throw new TypeError('key must be a storefront key: wcp_… (publishable) or wcs_… (private)');
  }
  const isPrivate = key.startsWith('wcs_');
  if (isPrivate && typeof document !== 'undefined' && !options.allowPrivateKeyInBrowser) {
    throw new TypeError(
      'A private storefront key (wcs_…) must never be used in a browser. Use a publishable key (wcp_…) there.',
    );
  }
  if (!isPrivate && options.shopperIp) {
    throw new TypeError('shopperIp is only sent with a private key (wcs_…)');
  }
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const retries = Math.max(0, Math.floor(options.rateLimitRetries ?? 0));
  const maxRetryAfter = options.maxRetryAfter ?? 10;

  function url(path: string, query?: Call['query']): string {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      params.set(name, String(value));
    }
    const search = params.toString();
    return search ? `${root}${path}?${search}` : root + path;
  }

  function headersOf(call: Call): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${key}`,
    };
    if (call.body !== undefined) headers['Content-Type'] = 'application/json';
    if (call.cartToken) headers['X-Cart-Token'] = call.cartToken;
    if (call.shopperToken) headers['X-Shopper-Token'] = call.shopperToken;
    if (call.idempotencyKey) headers['Idempotency-Key'] = call.idempotencyKey;
    const shopperIp = call.options?.shopperIp ?? options.shopperIp;
    if (shopperIp) {
      if (!isPrivate) throw new TypeError('shopperIp is only sent with a private key (wcs_…)');
      headers['X-Shopper-Ip'] = shopperIp;
    }
    return headers;
  }

  async function send<T>(call: Call): Promise<Envelope<T> | undefined> {
    const target = url(call.path, call.query);
    const headers = headersOf(call);
    const body = call.body === undefined ? undefined : JSON.stringify(call.body);
    const signal = call.options?.signal;
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await fetchImpl(target, { method: call.method, headers, body, signal });
      } catch (error) {
        if (isAbort(error)) throw error;
        throw new StorefrontError({
          status: 0,
          code: 'NETWORK_ERROR',
          message: 'The storefront API could not be reached',
          cause: error,
        });
      }
      if (response.status === 429 && attempt < retries) {
        const wait = parseRetryAfter(response.headers.get('retry-after'));
        if (wait !== null && wait <= maxRetryAfter) {
          await response.body?.cancel().catch(() => undefined);
          await sleep(wait * 1000, signal);
          continue;
        }
      }
      return readEnvelope<T>(response);
    }
  }

  async function data<T>(call: Call): Promise<T> {
    const envelope = await send<T>(call);
    return envelope?.data as T;
  }

  async function page<T>(call: Call): Promise<Page<T>> {
    const envelope = await send<T[]>(call);
    return {
      data: envelope?.data ?? [],
      pagination: envelope?.pagination ?? { hasMore: false, cursor: null },
    };
  }

  async function nothing(call: Call): Promise<void> {
    await send<unknown>(call);
  }

  const listProducts = async (opts?: ListProductsOptions) =>
    page<StorefrontProduct>({
      method: 'GET',
      path: '/products',
      query: {
        category: opts?.category,
        search: opts?.search,
        sort: opts?.sort,
        cursor: opts?.cursor,
        limit: opts?.limit,
      },
      options: opts,
    });

  const listOrders = async (shopperToken: string, opts?: ListOrdersOptions) =>
    page<StorefrontOrder>({
      method: 'GET',
      path: '/account/orders',
      query: { cursor: opts?.cursor, limit: opts?.limit },
      shopperToken: requireToken(shopperToken, 'shopperToken'),
      options: opts,
    });

  const decide = async (shopperToken: string, orderId: string, decision: 'approve' | 'reject', opts?: DecisionOptions) =>
    data<DecidedOrder>({
      method: 'POST',
      path: `/account/approvals/${segment(orderId, 'orderId')}/${decision}`,
      body: { comment: opts?.comment },
      shopperToken: requireToken(shopperToken, 'shopperToken'),
      options: opts,
    });

  const cartCall = (
    cartToken: string,
    method: Method,
    path: string,
    opts: ShopperOptions | undefined,
    body?: unknown,
  ): Call => ({
    method,
    path,
    body,
    cartToken: requireToken(cartToken, 'cartToken'),
    shopperToken: opts?.shopperToken,
    options: opts,
  });

  return {
    channel: {
      get: async (opts) => data({ method: 'GET', path: '/channel', options: opts }),
    },
    products: {
      list: listProducts,
      iterate: (opts) => paginate((cursor) => listProducts({ ...opts, cursor }), opts?.cursor),
      get: async (idOrSlug, opts) =>
        data({ method: 'GET', path: `/products/${segment(idOrSlug, 'idOrSlug')}`, options: opts }),
    },
    categories: {
      list: async (opts) => data({ method: 'GET', path: '/categories', options: opts }),
      get: async (idOrSlug, opts) =>
        data({ method: 'GET', path: `/categories/${segment(idOrSlug, 'idOrSlug')}`, options: opts }),
    },
    cart: {
      create: async (opts) =>
        data({
          method: 'POST',
          path: '/carts',
          body: { items: opts?.items, email: opts?.email },
          shopperToken: opts?.shopperToken,
          options: opts,
        }),
      get: async (cartToken, opts) => data(cartCall(cartToken, 'GET', '/cart', opts)),
      addItem: async (cartToken, item, opts) => data(cartCall(cartToken, 'POST', '/cart/items', opts, item)),
      updateItem: async (cartToken, lineId, quantity, opts) =>
        data(cartCall(cartToken, 'PATCH', `/cart/items/${segment(lineId, 'lineId')}`, opts, { quantity })),
      removeItem: async (cartToken, lineId, opts) =>
        data(cartCall(cartToken, 'DELETE', `/cart/items/${segment(lineId, 'lineId')}`, opts)),
      update: async (cartToken, input, opts) => data(cartCall(cartToken, 'PATCH', '/cart', opts, input)),
      shippingRates: async (cartToken, opts) => data(cartCall(cartToken, 'GET', '/cart/shipping-rates', opts)),
      setShippingRate: async (cartToken, shippingRateId, opts) =>
        data(cartCall(cartToken, 'PUT', '/cart/shipping-rate', opts, { shippingRateId })),
      applyDiscount: async (cartToken, code, opts) => data(cartCall(cartToken, 'POST', '/cart/discount', opts, { code })),
      removeDiscount: async (cartToken, opts) => data(cartCall(cartToken, 'DELETE', '/cart/discount', opts)),
      checkout: async (cartToken, input, opts) =>
        data({
          ...cartCall(cartToken, 'POST', '/cart/checkout', opts, input),
          idempotencyKey: opts?.idempotencyKey,
        }),
      quickOrder: async (input, opts) =>
        data({
          method: 'POST',
          path: '/cart/quick-order',
          body: input,
          cartToken: opts?.cartToken,
          shopperToken: opts?.shopperToken,
          options: opts,
        }),
    },
    payments: {
      get: async (paymentId, opts) =>
        data({ method: 'GET', path: `/payments/${segment(paymentId, 'paymentId')}`, options: opts }),
      retry: async (paymentId, opts) =>
        data({ method: 'POST', path: `/payments/${segment(paymentId, 'paymentId')}/retry`, options: opts }),
    },
    auth: {
      requestCode: async (email, opts) =>
        data({ method: 'POST', path: '/auth/code', body: { email, locale: opts?.locale }, options: opts }),
      verify: async (email, code, opts) =>
        data({ method: 'POST', path: '/auth/verify', body: { email, code }, options: opts }),
      signOut: async (shopperToken, opts) =>
        nothing({
          method: 'POST',
          path: '/auth/sign-out',
          shopperToken: requireToken(shopperToken, 'shopperToken'),
          options: opts,
        }),
    },
    account: {
      get: async (shopperToken, opts) =>
        data({ method: 'GET', path: '/account', shopperToken: requireToken(shopperToken, 'shopperToken'), options: opts }),
      update: async (shopperToken, input, opts) =>
        data({
          method: 'PATCH',
          path: '/account',
          body: input,
          shopperToken: requireToken(shopperToken, 'shopperToken'),
          options: opts,
        }),
      selectCompany: async (shopperToken, companyId, opts) =>
        data({
          method: 'PUT',
          path: '/account/company',
          body: { companyId },
          shopperToken: requireToken(shopperToken, 'shopperToken'),
          options: opts,
        }),
    },
    orders: {
      list: listOrders,
      iterate: (shopperToken, opts) => paginate((cursor) => listOrders(shopperToken, { ...opts, cursor }), opts?.cursor),
      get: async (shopperToken, orderId, opts) =>
        data({
          method: 'GET',
          path: `/account/orders/${segment(orderId, 'orderId')}`,
          shopperToken: requireToken(shopperToken, 'shopperToken'),
          options: opts,
        }),
      getGuest: async (orderId, orderToken, opts) =>
        data({
          method: 'GET',
          path: `/orders/${segment(orderId, 'orderId')}`,
          query: { token: requireToken(orderToken, 'orderToken') },
          options: opts,
        }),
      reorder: async (shopperToken, orderId, opts) =>
        data({
          method: 'POST',
          path: `/account/orders/${segment(orderId, 'orderId')}/reorder`,
          cartToken: opts?.cartToken,
          shopperToken: requireToken(shopperToken, 'shopperToken'),
          options: opts,
        }),
    },
    approvals: {
      list: async (shopperToken, opts) =>
        data({
          method: 'GET',
          path: '/account/approvals',
          shopperToken: requireToken(shopperToken, 'shopperToken'),
          options: opts,
        }),
      approve: (shopperToken, orderId, opts) => decide(shopperToken, orderId, 'approve', opts),
      reject: (shopperToken, orderId, opts) => decide(shopperToken, orderId, 'reject', opts),
    },
    buyers: {
      list: async (shopperToken, opts) =>
        data({
          method: 'GET',
          path: '/account/buyers',
          shopperToken: requireToken(shopperToken, 'shopperToken'),
          options: opts,
        }),
      invite: async (shopperToken, input, opts) =>
        data({
          method: 'POST',
          path: '/account/buyers',
          body: input,
          shopperToken: requireToken(shopperToken, 'shopperToken'),
          options: opts,
        }),
      update: async (shopperToken, buyerId, input, opts) =>
        data({
          method: 'PATCH',
          path: `/account/buyers/${segment(buyerId, 'buyerId')}`,
          body: input,
          shopperToken: requireToken(shopperToken, 'shopperToken'),
          options: opts,
        }),
      remove: async (shopperToken, buyerId, opts) =>
        nothing({
          method: 'DELETE',
          path: `/account/buyers/${segment(buyerId, 'buyerId')}`,
          shopperToken: requireToken(shopperToken, 'shopperToken'),
          options: opts,
        }),
    },
  };
}
