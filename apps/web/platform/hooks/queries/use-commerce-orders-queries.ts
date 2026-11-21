/**
 * WeldCommerce phase 2 query hooks: orders, discount codes and the module's
 * settings. Served by the Rust `commerce` module (EU edition); the contract is
 * `/orders`, `/discounts` and `/commerce-settings`.
 *
 * - Orders:    GET /orders (cursor-paged, filtered), GET /orders/:id,
 *              POST /orders/quote (a price check, writes nothing),
 *              POST /orders, PATCH /orders/:id, POST /orders/:id/cancel,
 *              POST /orders/:id/mark-paid
 * - Discounts: /discounts (CRUD) and /discounts/:id/redemptions
 * - Settings:  GET / PATCH /commerce-settings
 *
 * Money is a decimal string with two decimals (`"19.99"`); the UI never does
 * arithmetic on it, the quote endpoint does.
 */

import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { DataResponse, ListResponse } from '@weldsuite/core-api-client/types';
import { buildQueryString } from '@weldsuite/core-api-client/types';
import type { WeldstashProduct } from '@weldsuite/core-api-client/schemas/weldstash';
import { weldstashKeys } from '@/hooks/queries/use-weldstash-queries';
import { commerceKeys } from '@/hooks/queries/use-commerce-queries';

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export type OrderStatus = 'pending' | 'confirmed' | 'processing' | 'completed' | 'cancelled';
export type PaymentStatus = 'pending' | 'paid' | 'partially_refunded' | 'refunded' | 'failed' | 'on_invoice';
export type FulfillmentStatus = 'unfulfilled' | 'partial' | 'fulfilled';
export type ApprovalStatus = 'not_required' | 'pending' | 'approved' | 'rejected';
/** Why an order waits for approval: the buyer's spend limit or the company's approval threshold. */
export type ApprovalReason = 'buyer_limit' | 'company_threshold' | (string & {});

/** Who asked for or decided an approval: a shopper (`personId`) or a staff member (`userId`). */
export interface ApprovalActor {
  personId?: string | null;
  userId?: string | null;
  name: string | null;
  email?: string | null;
}

/** The approval of a B2B order (phase 6); `null` on an order that never needed one. */
export interface OrderApproval {
  status: Exclude<ApprovalStatus, 'not_required'>;
  reason: ApprovalReason;
  requestedBy: ApprovalActor | null;
  decidedBy: ApprovalActor | null;
  decidedAt: string | null;
  comment: string | null;
}

export interface OrderAddress {
  name?: string | null;
  company?: string | null;
  line1?: string | null;
  line2?: string | null;
  postalCode?: string | null;
  city?: string | null;
  region?: string | null;
  /** ISO 3166-1 alpha-2. */
  country?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface OrderSummary {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  fulfillmentStatus: FulfillmentStatus;
  approvalStatus: ApprovalStatus;
  /** `manual`, `storefront`, `shopify`, `woocommerce`, `picqer`, … as stored. */
  source: string;
  channelId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  personId: string | null;
  companyId: string | null;
  companyName: string | null;
  currency: string;
  total: string;
  itemCount: number;
  totalQuantity: number;
  placedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrderItem {
  id: string;
  productId: string | null;
  variantId: string | null;
  sku: string | null;
  name: string;
  variantName: string | null;
  imageUrl: string | null;
  quantity: number;
  fulfilledQuantity: number;
  unitPrice: string;
  discountAmount: string;
  taxAmount: string;
  /** Percent with two decimals ("21.00"). */
  taxRate: string | null;
  /** `standard`, `reduced`, `super_reduced`, `zero` or `exempt`; null on an item from before VAT was calculated. */
  vatCategory: string | null;
  /** What the buyer pays for the line, VAT included. */
  total: string;
}

/** How the VAT of an order was worked out (`imported`: a store's order, its own tax stands). */
export type VatTreatment =
  | 'domestic'
  | 'oss'
  | 'reverse_charge'
  | 'seller_rate_cross_border'
  | 'outside_eu'
  | 'imported';

/** VAT per rate: `base` is the net amount the rate applied to. */
export interface OrderTaxLine {
  rate: string;
  base: string;
  amount: string;
}

export interface OrderInvoiceRef {
  id: string;
  number: string | null;
  status: string;
}

export interface Order extends OrderSummary {
  items: OrderItem[];
  subtotal: string;
  discountTotal: string;
  shippingTotal: string;
  taxTotal: string;
  pricesIncludeTax: boolean;
  discountCode: string | null;
  discountId: string | null;
  billingAddress: OrderAddress | null;
  shippingAddress: OrderAddress | null;
  customerPhone: string | null;
  customerReference: string | null;
  customerNote: string | null;
  internalNote: string | null;
  destinationCountry: string | null;
  buyerVatNumber: string | null;
  /** Null: no VAT was calculated (an order from before VAT). */
  vatTreatment: VatTreatment | null;
  /** VIES could not be asked: the buyer was charged as a consumer. Recalculate when it is back. */
  viesUnavailable: boolean;
  /** Gross prices of a zero-rated sale: the seller's VAT taken off the shown prices. */
  vatRelief: string;
  taxLines: OrderTaxLine[];
  paymentMethod: string | null;
  paymentReference: string | null;
  paidAt: string | null;
  /** What has been paid (providers and manual payments); `amountPaid − amountRefunded` is still refundable. */
  amountPaid: string;
  amountRefunded: string;
  cancelledAt: string | null;
  cancelReason: string | null;
  completedAt: string | null;
  externalOrderId: string | null;
  tags: string[];
  invoice: OrderInvoiceRef | null;
  /** Free-form order data; `invoiceError` is set when the WeldBooks invoice of a paid order failed (phase 5). */
  metadata?: Record<string, unknown> | null;
  /** The approval a B2B order waits for or went through (phase 6). */
  approval: OrderApproval | null;
  /** Items and customer may still change. */
  editable: boolean;
  cancellable: boolean;
}

export interface OrderListParams {
  search?: string;
  status?: string;
  paymentStatus?: string;
  fulfillmentStatus?: string;
  /** `pending`, `approved`, `rejected` or `not_required`. */
  approvalStatus?: string;
  source?: string;
  channelId?: string;
  companyId?: string;
  personId?: string;
  /** ISO dates on createdAt. */
  from?: string;
  to?: string;
  sort?: 'createdAt' | '-createdAt' | 'total' | '-total' | 'orderNumber';
  limit?: number;
}

export interface OrderInputItem {
  variantId?: string | null;
  productId?: string | null;
  /** Required on a free line. */
  name?: string | null;
  quantity: number;
  /** A decimal string; defaults to the variant's, else the product's price. */
  unitPrice?: string | null;
}

export interface OrderInput {
  companyId?: string | null;
  personId?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  currency: string;
  items: OrderInputItem[];
  discountCode?: string | null;
  shippingTotal?: string | null;
  billingAddress?: OrderAddress | null;
  shippingAddress?: OrderAddress | null;
  customerReference?: string | null;
  customerNote?: string | null;
  internalNote?: string | null;
  /** Catalogue prices include VAT; the API's default is true. */
  pricesIncludeTax?: boolean;
  /** A business in another EU country: a valid number means reverse charge. */
  buyerVatNumber?: string | null;
  status?: 'pending' | 'confirmed';
  tags?: string[];
}

/** An edit: a line with an `id` updates that item, one without is added, one left out is removed. */
export interface OrderPatchItem extends OrderInputItem {
  id?: string;
}

export interface OrderPatch {
  billingAddress?: OrderAddress | null;
  shippingAddress?: OrderAddress | null;
  customerReference?: string | null;
  customerNote?: string | null;
  internalNote?: string | null;
  tags?: string[];
  /** Forward only: pending → confirmed → processing → completed. */
  status?: Exclude<OrderStatus, 'cancelled'>;
  // Only while the order is editable:
  companyId?: string | null;
  personId?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  shippingTotal?: string | null;
  discountCode?: string | null;
  pricesIncludeTax?: boolean;
  buyerVatNumber?: string | null;
  items?: OrderPatchItem[];
}

export type QuoteLineProblem = 'PRODUCT_NOT_FOUND' | 'NO_PRICE' | 'INACTIVE' | (string & {});

export type DiscountProblem =
  | 'NOT_FOUND'
  | 'NOT_ACTIVE'
  | 'NOT_STARTED'
  | 'EXPIRED'
  | 'USAGE_LIMIT'
  | 'CUSTOMER_LIMIT'
  | 'MINIMUM_SUBTOTAL'
  | 'MINIMUM_QUANTITY'
  | 'CURRENCY'
  | 'NOT_ELIGIBLE';

export interface OrderQuoteLine {
  variantId: string | null;
  productId: string | null;
  sku: string | null;
  name: string;
  variantName: string | null;
  quantity: number;
  unitPrice: string;
  discountAmount: string;
  taxRate: string | null;
  taxAmount: string;
  vatCategory: string;
  /** With VAT. */
  total: string;
  problem: QuoteLineProblem | null;
}

export interface OrderQuote {
  currency: string;
  /** In the order of the input's lines. */
  lines: OrderQuoteLine[];
  subtotal: string;
  discountTotal: string;
  shippingTotal: string;
  taxTotal: string;
  total: string;
  discount: { id: string; code: string; type: string; value: string } | null;
  discountProblem: DiscountProblem | null;
  vatTreatment: VatTreatment | null;
  destinationCountry: string | null;
  viesUnavailable: boolean;
  pricesIncludeTax: boolean;
  vatRelief: string;
  taxLines: OrderTaxLine[];
}

export interface MarkPaidInput {
  paidAt?: string;
  paymentMethod?: string;
  paymentReference?: string;
}

// ---------------------------------------------------------------------------
// Discounts
// ---------------------------------------------------------------------------

export type DiscountType = 'percentage' | 'fixed_amount' | 'free_shipping';
export type DiscountStatus = 'draft' | 'active' | 'archived';
export type DiscountAppliesTo = 'all' | 'products' | 'categories';
/** The stored status folded with the dates and the usage. */
export type DiscountEffectiveStatus = 'draft' | 'scheduled' | 'active' | 'expired' | 'used_up' | 'archived';

export interface CommerceDiscount {
  id: string;
  name: string;
  description: string | null;
  code: string;
  type: DiscountType;
  /** A percentage 0..100, an amount, or "0" for free shipping. */
  value: string;
  /** Required for a fixed amount. */
  currency: string | null;
  maxDiscountAmount: string | null;
  appliesTo: DiscountAppliesTo;
  productIds: string[];
  variantIds: string[];
  categoryIds: string[];
  minimumSubtotal: string | null;
  minimumQuantity: number | null;
  usageLimit: number | null;
  usageLimitPerCustomer: number | null;
  usageCount: number;
  status: DiscountStatus;
  effectiveStatus: DiscountEffectiveStatus | (string & {});
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Create body; an update sends any of these. `null` clears an optional field. */
export interface DiscountInput {
  name?: string;
  description?: string | null;
  code?: string;
  type?: DiscountType;
  value?: string;
  currency?: string | null;
  maxDiscountAmount?: string | null;
  appliesTo?: DiscountAppliesTo;
  productIds?: string[];
  variantIds?: string[];
  categoryIds?: string[];
  minimumSubtotal?: string | null;
  minimumQuantity?: number | null;
  usageLimit?: number | null;
  usageLimitPerCustomer?: number | null;
  status?: DiscountStatus;
  startsAt?: string | null;
  endsAt?: string | null;
}

export interface DiscountListParams {
  search?: string;
  status?: string;
  effectiveStatus?: string;
  limit?: number;
}

export interface DiscountRedemption {
  id: string;
  orderId: string;
  orderNumber: string | null;
  customerEmail: string | null;
  personId: string | null;
  amount: string;
  currency: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface CommerceSettings {
  orderNumberPrefix: string;
  nextOrderNumber: number;
  defaultCurrency: string;
}

export const commerceOrderKeys = {
  orders: () => [...commerceKeys.all, 'orders'] as const,
  orderList: (params?: OrderListParams) => [...commerceOrderKeys.orders(), 'list', params ?? {}] as const,
  order: (id: string) => [...commerceOrderKeys.orders(), 'detail', id] as const,
  quote: (input: OrderInput | null) => [...commerceOrderKeys.orders(), 'quote', input] as const,
  discounts: () => [...commerceKeys.all, 'discounts'] as const,
  discountList: (params?: DiscountListParams) => [...commerceOrderKeys.discounts(), 'list', params ?? {}] as const,
  discount: (id: string) => [...commerceOrderKeys.discounts(), 'detail', id] as const,
  redemptions: (id: string) => [...commerceOrderKeys.discount(id), 'redemptions'] as const,
  settings: () => [...commerceKeys.all, 'settings'] as const,
};

function nextPage<T extends { pagination?: { hasMore?: boolean; cursor?: string | null } }>(lastPage: T) {
  return lastPage.pagination?.hasMore ? (lastPage.pagination.cursor ?? undefined) : undefined;
}

// ---------------------- Orders ----------------------

/** The order list, cursor-paged. */
export function useInfiniteCommerceOrders(params: OrderListParams, enabled = true) {
  const { getClient } = useAppApiClient();
  return useInfiniteQuery({
    queryKey: commerceOrderKeys.orderList(params),
    queryFn: async ({ pageParam }) => {
      const client = await getClient();
      const qs = buildQueryString({ ...params, cursor: pageParam } as Record<string, unknown>);
      return client.get<ListResponse<OrderSummary>>(`/orders${qs}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextPage,
    enabled,
  });
}

export function useCommerceOrder(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: commerceOrderKeys.order(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<Order>>(`/orders/${id}`);
    },
    enabled: !!id && enabled,
  });
}

/**
 * What an order would cost, priced by the server (`POST /orders/quote`): no
 * write, so it is safe to ask on every pause in typing. Pass null while the
 * order has nothing to price. The previous quote stays on screen while the
 * next one loads, so the totals don't flicker.
 */
export function useOrderQuote(input: OrderInput | null) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: commerceOrderKeys.quote(input),
    queryFn: async () => {
      const client = await getClient();
      return client.post<DataResponse<OrderQuote>>('/orders/quote', input);
    },
    enabled: input !== null,
    placeholderData: keepPreviousData,
    gcTime: 60_000,
  });
}

/** After an order write: every order list and detail, the overview counters, and (a code was used) the discounts. */
function useInvalidateOrders() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: commerceOrderKeys.orders() });
    void qc.invalidateQueries({ queryKey: commerceKeys.overview() });
    void qc.invalidateQueries({ queryKey: commerceOrderKeys.discounts() });
  };
}

export function useCreateCommerceOrder() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateOrders();
  return useMutation({
    mutationFn: async (data: OrderInput) => {
      const client = await getClient();
      return client.post<DataResponse<{ id: string; orderNumber: string }>>('/orders', data);
    },
    onSuccess: invalidate,
  });
}

export function useUpdateCommerceOrder() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateOrders();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: OrderPatch }) => {
      const client = await getClient();
      return client.patch<DataResponse<Order>>(`/orders/${id}`, data);
    },
    onSuccess: invalidate,
  });
}

export function useCancelCommerceOrder() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateOrders();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason?: string }) => {
      const client = await getClient();
      return client.post<DataResponse<Order>>(`/orders/${id}/cancel`, reason ? { reason } : {});
    },
    onSuccess: invalidate,
  });
}

/** `POST /orders/:id/recalculate-tax`: the VAT of an editable order again (409 `ORDER_TAX_LOCKED` otherwise). */
export function useRecalculateCommerceOrderTax() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateOrders();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.post<DataResponse<Order>>(`/orders/${id}/recalculate-tax`, {});
    },
    onSuccess: invalidate,
  });
}

export function useMarkCommerceOrderPaid() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateOrders();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: MarkPaidInput }) => {
      const client = await getClient();
      return client.post<DataResponse<Order>>(`/orders/${id}/mark-paid`, data);
    },
    onSuccess: invalidate,
  });
}

// ---------------------- Discounts ----------------------

export function useInfiniteCommerceDiscounts(params: DiscountListParams, enabled = true) {
  const { getClient } = useAppApiClient();
  return useInfiniteQuery({
    queryKey: commerceOrderKeys.discountList(params),
    queryFn: async ({ pageParam }) => {
      const client = await getClient();
      const qs = buildQueryString({ ...params, cursor: pageParam } as Record<string, unknown>);
      return client.get<ListResponse<CommerceDiscount>>(`/discounts${qs}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextPage,
    enabled,
  });
}

export function useCommerceDiscount(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: commerceOrderKeys.discount(id),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<CommerceDiscount>>(`/discounts/${id}`);
    },
    enabled: !!id && enabled,
  });
}

export function useCreateCommerceDiscount() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: DiscountInput) => {
      const client = await getClient();
      return client.post<DataResponse<{ id: string }>>('/discounts', data);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: commerceOrderKeys.discounts() }),
  });
}

export function useUpdateCommerceDiscount() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: DiscountInput }) => {
      const client = await getClient();
      return client.patch<DataResponse<CommerceDiscount>>(`/discounts/${id}`, data);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: commerceOrderKeys.discounts() }),
  });
}

export function useDeleteCommerceDiscount() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete<void>(`/discounts/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: commerceOrderKeys.discounts() }),
  });
}

/** The orders a code was used on, newest first, cursor-paged. */
export function useCommerceDiscountRedemptions(id: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useInfiniteQuery({
    queryKey: commerceOrderKeys.redemptions(id),
    queryFn: async ({ pageParam }) => {
      const client = await getClient();
      const qs = buildQueryString({ cursor: pageParam } as Record<string, unknown>);
      return client.get<ListResponse<DiscountRedemption>>(`/discounts/${id}/redemptions${qs}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextPage,
    enabled: !!id && enabled,
  });
}

/**
 * The products behind a discount's product ids, one cached `/products/:id`
 * read each (the same cache as WeldStash's product panel). An id the member
 * can no longer read comes back without a product.
 */
export function useProductsByIds(ids: string[]) {
  const { getClient } = useAppApiClient();
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: weldstashKeys.product(id),
      queryFn: async () => {
        const client = await getClient();
        return client.get<DataResponse<WeldstashProduct>>(`/products/${id}`);
      },
      staleTime: 60_000,
    })),
  });
}

// ---------------------- Settings ----------------------

export function useCommerceSettings(enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: commerceOrderKeys.settings(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<CommerceSettings>>('/commerce-settings');
    },
    enabled,
  });
}

export function useUpdateCommerceSettings() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: Partial<CommerceSettings>) => {
      const client = await getClient();
      return client.patch<DataResponse<CommerceSettings>>('/commerce-settings', data);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: commerceOrderKeys.settings() }),
  });
}
