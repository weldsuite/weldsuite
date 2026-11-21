/**
 * The shapes the WeldCommerce storefront API (`/storefront/v1`) answers with.
 *
 * Money is a decimal string with two decimals ("19.99"): every amount field
 * (`price`, `unitPrice`, `subtotal`, `total`, `spendLimit`, …) is typed
 * `string` and holds one. Never turn it into a float to do sums. Format it with `formatMoney`, compare it with
 * `compareMoney`. Timestamps are ISO 8601 strings, country codes ISO 3166-1
 * alpha-2 ("NL"), currencies ISO 4217 ("EUR").
 *
 * String unions end in `(string & {})` where the server may add values later,
 * so a newer server never breaks your build.
 */

/** An open string union: the known values, plus any string a newer server sends. */
export type Open<T extends string> = T | (string & Record<never, never>);

// ── Channel ─────────────────────────────────────────────────────────────────

export type ChannelAudience = 'b2c' | 'b2b';
export type PaymentMethod = 'mollie' | 'invoice';

/** The sales channel the key belongs to. */
export interface StorefrontChannel {
  id: string;
  name: string;
  audience: ChannelAudience;
  /** The currency every price on this channel is in. */
  currency: string;
  /** B2C channels usually show prices with VAT; B2B channels without. */
  pricesIncludeTax: boolean;
  /** The countries the channel ships to (ISO-2). */
  sellingCountries: string[];
  /** Whether shoppers can check out without signing in. */
  guestCheckout: boolean;
  paymentMethods: PaymentMethod[];
}

// ── Catalogue ───────────────────────────────────────────────────────────────

export interface ProductImage {
  url: string;
  altText: string | null;
}

export interface ProductOption {
  /** E.g. "Size". */
  name: string;
  /** E.g. ["S", "M", "L"]. */
  values: string[];
}

export interface CategoryRef {
  id: string;
  slug: string;
  name: string;
}

export interface StorefrontVariant {
  id: string;
  name: string | null;
  sku: string | null;
  /** Option name → value, e.g. `{ Size: "M", Colour: "Blue" }`. */
  optionValues: Record<string, string>;
  price: string;
  compareAtPrice: string | null;
  /** Active, and in stock (or backorders allowed, or stock not tracked). */
  available: boolean;
}

export interface StorefrontProduct {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  featuredImageUrl: string | null;
  images: ProductImage[];
  currency: string;
  /** The lowest variant price when the product has variants. */
  price: string;
  compareAtPrice: string | null;
  options: ProductOption[];
  /** Empty for a product without variants. */
  variants: StorefrontVariant[];
  available: boolean;
  categories: CategoryRef[];
}

export interface StorefrontCategory {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  parentId: string | null;
  children: StorefrontCategory[];
}

export type ProductSort = 'name' | '-name' | 'price' | '-price' | 'newest';

export interface ListProductsParams {
  /** A category id or slug. Automated categories work too. */
  category?: string;
  /** Matches the name, SKU, brand, vendor and short description (at most 100 characters). */
  search?: string;
  /** Default `name`. */
  sort?: ProductSort;
  /**
   * The `pagination.cursor` of the previous page, with the same `sort`
   * (another sort's cursor is 400 `INVALID_CURSOR`).
   */
  cursor?: string;
  /** 1 to 100, default 24. */
  limit?: number;
}

export interface Pagination {
  hasMore: boolean;
  /**
   * An opaque cursor: pass it back as `cursor` for the next page; `null` on
   * the last page. Don't build or change one: a cursor the list didn't give
   * out is 400 `INVALID_CURSOR`.
   */
  cursor: string | null;
}

/** One page of a list. */
export interface Page<T> {
  data: T[];
  pagination: Pagination;
}

// ── Addresses ───────────────────────────────────────────────────────────────

/**
 * A postal address. A shipping address is complete (and the cart can be
 * checked out) with `country`, `line1`, `city` and `postalCode`. The server
 * trims every field, drops blank ones and upper-cases `country`.
 */
export interface Address {
  /** The recipient's full name. At most 255 characters. */
  name?: string | null;
  company?: string | null;
  line1?: string | null;
  line2?: string | null;
  /** At most 30 characters. */
  postalCode?: string | null;
  /** At most 120 characters. */
  city?: string | null;
  /** State or province, at most 120 characters. */
  region?: string | null;
  /** ISO 3166-1 alpha-2, e.g. "NL". */
  country?: string | null;
  /** At most 50 characters. */
  phone?: string | null;
}

// ── Carts ───────────────────────────────────────────────────────────────────

export type CartStatus = Open<'open' | 'checkout' | 'completed' | 'abandoned' | 'expired'>;
export type CartLineProblem = 'OUT_OF_STOCK' | 'NO_PRICE' | 'INACTIVE';
export type CartMissing = 'items' | 'email' | 'shippingAddress' | 'shippingRate' | 'billingAddress';
export type DiscountType = Open<'percentage' | 'fixed_amount' | 'free_shipping'>;

/** Why a discount code does not apply. */
export type DiscountProblem = Open<
  | 'NOT_FOUND'
  | 'NOT_ACTIVE'
  | 'NOT_STARTED'
  | 'EXPIRED'
  | 'USAGE_LIMIT'
  | 'CUSTOMER_LIMIT'
  | 'MINIMUM_SUBTOTAL'
  | 'MINIMUM_QUANTITY'
  | 'CURRENCY'
  | 'NOT_ELIGIBLE'
>;

/** How VAT is charged on the cart or order, once the destination is known. */
export type VatTreatment = Open<'domestic' | 'oss' | 'reverse_charge' | 'outside_eu' | 'seller_rate_cross_border'>;

export interface CartLine {
  id: string;
  productId: string;
  variantId: string | null;
  sku: string | null;
  name: string;
  variantName: string | null;
  imageUrl: string | null;
  quantity: number;
  /** In the channel's price mode (with or without VAT, see `Cart.pricesIncludeTax`). */
  unitPrice: string;
  /** `unitPrice × quantity`, before the cart's discount. */
  total: string;
  /** E.g. "21.00", once the destination is known; `null` before. */
  taxRate: string | null;
  available: boolean;
  problem: CartLineProblem | null;
}

export interface TaxLine {
  /** E.g. "21.00". */
  rate: string;
  base: string;
  amount: string;
}

export interface Cart {
  id: string;
  status: CartStatus;
  currency: string;
  pricesIncludeTax: boolean;
  email: string | null;
  items: CartLine[];
  itemCount: number;
  subtotal: string;
  discountTotal: string;
  /** The chosen rate's price ("0.00" when free shipping applies). */
  shippingTotal: string;
  /** "0.00" until the shipping address is known. */
  taxTotal: string;
  total: string;
  taxLines: TaxLine[];
  vatTreatment: VatTreatment | null;
  /** The EU VIES service could not check the buyer's VAT number just now. */
  viesUnavailable: boolean;
  discount: { code: string; type: DiscountType; value: string } | null;
  /** Set when the applied code no longer applies (the cart changed). */
  discountProblem: DiscountProblem | null;
  shippingAddress: Address | null;
  /** Defaults to the shipping address. */
  billingAddress: Address | null;
  shippingRate: { id: string; name: string; price: string } | null;
  buyerVatNumber: string | null;
  customerReference: string | null;
  note: string | null;
  /** True when the cart can be checked out. */
  ready: boolean;
  /** What is still needed before checkout. */
  missing: CartMissing[];
  /** The order the cart became, once checked out. */
  orderId: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

/** A line to add: a product without variants, or a variant. */
export interface CartItemInput {
  /** Required for a product that has variants. */
  variantId?: string;
  productId?: string;
  quantity: number;
}

export interface CreateCartInput {
  /** At most 100 lines. */
  items?: CartItemInput[];
  email?: string;
}

export interface CreatedCart {
  cart: Cart;
  /**
   * The cart's secret token (`wct_…`), shown once. Keep it (in an httpOnly
   * cookie, or in storage for a browser-only shop) and send it with every
   * cart call.
   */
  cartToken: string;
}

/** The fields a shopper fills in at checkout. `null` clears a field. */
export interface UpdateCartInput {
  email?: string | null;
  shippingAddress?: Address | null;
  billingAddress?: Address | null;
  /** B2B: the buyer's EU VAT number, checked against VIES for reverse charge. */
  buyerVatNumber?: string | null;
  /** B2B: the buyer's purchase order number or reference (at most 100 characters). */
  customerReference?: string | null;
  /** At most 1000 characters. */
  note?: string | null;
}

export interface ShippingRateOffer {
  id: string;
  name: string;
  /** "0.00" when `free`. */
  price: string;
  /** The cart's subtotal reaches the rate's free-shipping threshold. */
  free: boolean;
}

// ── Checkout and orders ─────────────────────────────────────────────────────

export interface CheckoutInput {
  paymentMethod: PaymentMethod;
  /**
   * The total the shopper saw (`cart.total`). When the server works out a
   * different total, checkout fails with `PRICE_CHANGED` instead of charging it.
   */
  expectedTotal?: string;
  /**
   * Mollie only: where Mollie sends the shopper back (`https://…`, with
   * `order=<orderId>&payment=<paymentId>` added). With a publishable key its
   * origin must be one of the key's allowed origins (`REDIRECT_NOT_ALLOWED`).
   */
  redirectUrl?: string;
  /**
   * A link to the order for the confirmation email: an `https://` URL with
   * `{orderId}` and `{token}` placeholders, e.g.
   * `https://shop.example.com/orders/{orderId}?token={token}`. `{token}` is
   * empty for a signed-in shopper. Another shape is 400 `VALIDATION_ERROR`;
   * with a publishable key its origin must be one of the key's allowed
   * origins (`ORDER_URL_NOT_ALLOWED`).
   */
  orderUrl?: string;
}

export type OrderStatus = Open<'pending' | 'confirmed' | 'processing' | 'shipped' | 'delivered' | 'completed' | 'cancelled'>;
export type OrderPaymentStatus = Open<
  'pending' | 'paid' | 'on_invoice' | 'partially_refunded' | 'refunded' | 'failed'
>;
export type ApprovalStatus = Open<'not_required' | 'pending' | 'approved' | 'rejected'>;

export interface StorefrontOrderItem {
  id: string;
  name: string;
  variantName: string | null;
  sku: string | null;
  quantity: number;
  unitPrice: string;
  total: string;
  taxRate: string | null;
}

export interface StorefrontOrder {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: OrderPaymentStatus;
  fulfillmentStatus: string;
  currency: string;
  pricesIncludeTax: boolean;
  items: StorefrontOrderItem[];
  subtotal: string;
  discountTotal: string;
  shippingTotal: string;
  taxTotal: string;
  total: string;
  vatTreatment: VatTreatment | null;
  shippingAddress: Address | null;
  billingAddress: Address | null;
  placedAt: string;
  /**
   * B2B: whether the order waits for a company approver (`pending`); an
   * order that needs none is `not_required`.
   */
  approvalStatus: ApprovalStatus;
  /** The signed-in shopper who placed the order; `null` for a guest order. */
  placedBy: { personId: string; name: string | null } | null;
}

/**
 * An order an approver just decided on. `payment` is set when a Mollie
 * order was approved and its payment started (the buyer is emailed the
 * link too).
 */
export interface DecidedOrder extends StorefrontOrder {
  payment: CheckoutPayment | null;
}

export type PaymentStatus = Open<'open' | 'pending' | 'authorized' | 'paid' | 'failed' | 'canceled' | 'expired'>;

export interface CheckoutPayment {
  id: string;
  status: PaymentStatus;
  /** Send the shopper here to pay. */
  checkoutUrl: string | null;
}

export interface CheckoutResult {
  /** The placed order; `approvalStatus: 'pending'` when a B2B order waits for approval. */
  order: StorefrontOrder;
  /**
   * The Mollie payment; `null` when paying on invoice, and for a Mollie
   * order that waits for approval (it gets its payment once approved).
   */
  payment: CheckoutPayment | null;
  /**
   * A guest's order token (`wot_…`), returned once: with the order id it
   * opens the order through `orders.getGuest`. Only its hash is stored, so
   * keep it. `null` for a signed-in shopper, and when an `Idempotency-Key`
   * retry returns an earlier checkout.
   */
  orderToken: string | null;
}

/** A payment as the shop's return page reads it. */
export interface PaymentInfo {
  id: string;
  status: PaymentStatus;
  orderId: string;
  orderNumber: string;
  checkoutUrl: string | null;
}

// ── Shoppers ────────────────────────────────────────────────────────────────

export type BuyerRole = 'buyer' | 'approver' | 'admin';

export interface ShopperCompany {
  id: string;
  name: string;
  role: BuyerRole;
  /** The most one order may total before it needs approval. */
  spendLimit: string | null;
  currency: string | null;
}

export interface Shopper {
  personId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  /** B2B: the companies the shopper buys for. */
  companies: ShopperCompany[];
  /** The company the shopper buys for now. */
  activeCompanyId: string | null;
}

export interface ShopperSession {
  /**
   * The session token (`wss_…`). Send it as the shopper token. It works on
   * this channel only, for 30 days; after that calls answer 401
   * `SESSION_EXPIRED`.
   */
  sessionToken: string;
  expiresAt: string;
  shopper: Shopper;
}

/** The languages the sign-in email is written in. */
export type SignInLocale = 'en' | 'nl';

export interface RequestCodeInput {
  /** The sign-in email's language; without it the server picks one. */
  locale?: SignInLocale;
}

export interface UpdateAccountInput {
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
}

export interface ListOrdersParams {
  /** The opaque `pagination.cursor` of the previous page. */
  cursor?: string;
  /** 1 to 100, default 25. */
  limit?: number;
}

export type LineProblemCode = 'UNKNOWN_SKU' | 'NOT_SELLABLE' | 'NO_PRICE' | 'INVALID_QUANTITY' | 'OUT_OF_STOCK';

/**
 * A line of a quick order or a reorder to look at. Every other line was
 * added. An `OUT_OF_STOCK` line was added too (with more than is on hand),
 * and is reported so the shopper knows; the other problems were not added.
 */
export interface LineProblem {
  /**
   * Quick order: the 1-based position in `lines`, or the CSV line number
   * (a header line counts). Reorder: `null`.
   */
  row: number | null;
  sku: string | null;
  productId: string | null;
  problem: LineProblemCode;
  message: string;
}

export interface CartWithProblems {
  cart: Cart;
  /** Only when a new cart was made: keep it like `CreatedCart.cartToken`. */
  cartToken: string | null;
  problems: LineProblem[];
}

/**
 * SKUs and quantities. SKUs match exactly but case-insensitively, variants
 * first. When both are sent, `lines` come before the CSV's rows; at most 500
 * rows in all (more is 400 `VALIDATION_ERROR`).
 */
export interface QuickOrderInput {
  lines?: Array<{ sku: string; quantity: number }>;
  /** `sku,quantity` per line (`;` or a tab work too), a `sku,quantity` header optional. */
  csv?: string;
}

// ── B2B ─────────────────────────────────────────────────────────────────────

export type ApprovalReason = Open<'buyer_limit' | 'company_threshold'>;

export interface Approval {
  order: StorefrontOrder;
  reason: ApprovalReason;
  /** The buyer who placed the order; `null` when that person is gone. */
  requestedBy: { personId: string; name: string | null } | null;
}

export type BuyerStatus = 'invited' | 'active' | 'disabled';

export interface Buyer {
  id: string;
  personId: string;
  companyId: string;
  name: string | null;
  email: string;
  role: BuyerRole;
  spendLimit: string | null;
  spendLimitCurrency: string | null;
  status: BuyerStatus;
  invitedAt: string | null;
  acceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InviteBuyerInput {
  email: string;
  /** At most 100 characters. */
  firstName?: string;
  /** At most 100 characters. */
  lastName?: string;
  role: BuyerRole;
  /** The most one order may total before it needs approval, in the channel's currency. */
  spendLimit?: string | null;
}

export interface UpdateBuyerInput {
  role?: BuyerRole;
  /** In the channel's currency; `null` removes the limit. */
  spendLimit?: string | null;
  status?: BuyerStatus;
}
