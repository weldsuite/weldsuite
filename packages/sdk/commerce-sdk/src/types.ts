/**
 * The shapes the WeldCommerce storefront API (`/storefront/v1`) answers with.
 *
 * Money is a decimal string with two decimals ("19.99"): never turn it into a
 * float to do sums. Format it with `formatMoney`, compare it with
 * `compareMoney`. Timestamps are ISO 8601 strings, country codes ISO 3166-1
 * alpha-2 ("NL"), currencies ISO 4217 ("EUR").
 *
 * String unions end in `(string & {})` where the server may add values later,
 * so a newer server never breaks your build.
 */

/** A decimal amount as a string, e.g. "19.99". */
export type Money = string;

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
  price: Money;
  compareAtPrice: Money | null;
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
  price: Money;
  compareAtPrice: Money | null;
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
  /** The `pagination.cursor` of the previous page. */
  cursor?: string;
  /** 1 to 100, default 24. */
  limit?: number;
}

export interface Pagination {
  hasMore: boolean;
  /** Pass it as `cursor` to get the next page; `null` on the last page. */
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
  unitPrice: Money;
  /** `unitPrice × quantity`, before the cart's discount. */
  total: Money;
  /** E.g. "21.00", once the destination is known; `null` before. */
  taxRate: string | null;
  available: boolean;
  problem: CartLineProblem | null;
}

export interface TaxLine {
  /** E.g. "21.00". */
  rate: string;
  base: Money;
  amount: Money;
}

export interface Cart {
  id: string;
  status: CartStatus;
  currency: string;
  pricesIncludeTax: boolean;
  email: string | null;
  items: CartLine[];
  itemCount: number;
  subtotal: Money;
  discountTotal: Money;
  /** The chosen rate's price ("0.00" when free shipping applies). */
  shippingTotal: Money;
  /** "0.00" until the shipping address is known. */
  taxTotal: Money;
  total: Money;
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
  shippingRate: { id: string; name: string; price: Money } | null;
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
  price: Money;
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
  expectedTotal?: Money;
  /**
   * Mollie only: where Mollie sends the shopper back (`https://…`, with
   * `order=<orderId>` added). With a publishable key its origin must be one
   * of the key's allowed origins.
   */
  redirectUrl?: string;
  /**
   * A link to the order for the confirmation email: an `https://` URL with
   * `{orderId}` and `{token}` placeholders, e.g.
   * `https://shop.example.com/orders/{orderId}?token={token}`. `{token}` is
   * empty for a signed-in shopper.
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
  unitPrice: Money;
  total: Money;
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
  subtotal: Money;
  discountTotal: Money;
  shippingTotal: Money;
  taxTotal: Money;
  total: Money;
  vatTreatment: VatTreatment | null;
  shippingAddress: Address | null;
  billingAddress: Address | null;
  placedAt: string;
  /** B2B: whether the order waits for a company approver. */
  approvalStatus?: ApprovalStatus;
  /** B2B: who placed the order, on orders a company approver or admin sees. */
  placedBy?: { personId: string; name: string | null } | null;
}

export type PaymentStatus = Open<'open' | 'pending' | 'authorized' | 'paid' | 'failed' | 'canceled' | 'expired'>;

export interface CheckoutPayment {
  id: string;
  status: PaymentStatus;
  /** Send the shopper here to pay. */
  checkoutUrl: string | null;
}

export interface CheckoutResult {
  order: StorefrontOrder;
  /** The Mollie payment; `null` when paying on invoice. */
  payment: CheckoutPayment | null;
  /**
   * A guest's order token, returned once: with the order id it opens the
   * order through `orders.getGuest`. `null` for a signed-in shopper.
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
  spendLimit: Money | null;
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
  /** The session token (`wss_…`). Send it as the shopper token. */
  sessionToken: string;
  expiresAt: string;
  shopper: Shopper;
}

export interface UpdateAccountInput {
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
}

export interface ListOrdersParams {
  cursor?: string;
  limit?: number;
}

export type LineProblemCode = 'UNKNOWN_SKU' | 'NOT_SELLABLE' | 'NO_PRICE' | 'INVALID_QUANTITY' | 'OUT_OF_STOCK';

/** A line a quick order or a reorder could not add. The other lines were added. */
export interface LineProblem {
  /** The CSV row (1-based), for a CSV quick order. */
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

export interface QuickOrderInput {
  lines?: Array<{ sku: string; quantity: number }>;
  /** `sku,quantity` per row, header optional, at most 500 rows. */
  csv?: string;
}

// ── B2B ─────────────────────────────────────────────────────────────────────

export type ApprovalReason = Open<'buyer_limit' | 'company_threshold'>;

export interface Approval {
  order: StorefrontOrder;
  reason: ApprovalReason;
  requestedBy: { personId: string; name: string | null };
}

export type BuyerStatus = 'invited' | 'active' | 'disabled';

export interface Buyer {
  id: string;
  personId: string;
  companyId: string;
  name: string | null;
  email: string;
  role: BuyerRole;
  spendLimit: Money | null;
  spendLimitCurrency: string | null;
  status: BuyerStatus;
  invitedAt: string | null;
  acceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InviteBuyerInput {
  email: string;
  firstName?: string;
  lastName?: string;
  role: BuyerRole;
  spendLimit?: Money | null;
}

export interface UpdateBuyerInput {
  role?: BuyerRole;
  spendLimit?: Money | null;
  status?: BuyerStatus;
}
