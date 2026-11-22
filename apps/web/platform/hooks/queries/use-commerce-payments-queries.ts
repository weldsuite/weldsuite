/**
 * WeldCommerce phase 5 query hooks: the Mollie connection of the workspace and
 * the payments and refunds of an order. Served by the Rust `commerce` module
 * (EU edition); the contract is `/commerce-payments/connection` and
 * `/orders/:id/payments`.
 *
 * - Connection: GET /commerce-payments/connection, POST
 *               /commerce-payments/connection/mollie/authorize (the URL to
 *               send the member to) and /mollie/api-key, GET
 *               /connection/profiles, PATCH and DELETE /connection. Tokens and
 *               keys never come back from the API.
 * - Orders:     GET /orders/:id/payments, POST /orders/:id/payment-link,
 *               POST /orders/:id/refunds, POST /orders/:id/invoice
 *
 * Every key sits under `['weldcommerce', 'payments']`: the
 * `commerce_payment_connection` realtime event invalidates that prefix.
 * Money is a decimal string with two decimals.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { DataResponse } from '@weldsuite/core-api-client/types';
import { commerceKeys } from '@/hooks/queries/use-commerce-queries';
import { commerceOrderKeys } from '@/hooks/queries/use-commerce-orders-queries';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PaymentConnectionStatus = 'connected' | 'needs_reauth' | 'disconnected';
export type PaymentAuthMethod = 'oauth' | 'api_key';

export interface PaymentConnection {
  id: string;
  provider: 'mollie';
  authMethod: PaymentAuthMethod;
  status: PaymentConnectionStatus;
  /** An API key connection follows its key (`test_…`); an OAuth connection can be switched. */
  testmode: boolean;
  profileId: string | null;
  profileName: string | null;
  organizationId: string | null;
  organizationName: string | null;
  connectedAt: string;
  lastError: string | null;
  /** The install has a Mollie Connect app configured. */
  oauthAvailable: boolean;
}

/** `{ data: null }` when nothing is connected; `meta` then still says whether OAuth is offered. */
export interface PaymentConnectionResponse {
  data: PaymentConnection | null;
  meta?: { oauthAvailable?: boolean };
}

export interface MollieProfile {
  id: string;
  name: string;
  website: string | null;
  mode: string;
}

export interface MollieApiKeyInput {
  /** `live_…` or `test_…`. */
  apiKey: string;
  profileId?: string;
}

export interface PaymentConnectionPatch {
  profileId?: string;
  testmode?: boolean;
}

export type OrderPaymentStatus = 'open' | 'pending' | 'authorized' | 'paid' | 'failed' | 'canceled' | 'expired';
export type OrderRefundStatus = 'pending' | 'queued' | 'processing' | 'refunded' | 'failed' | 'canceled';

export interface OrderPayment {
  id: string;
  provider: 'mollie';
  providerPaymentId: string | null;
  status: OrderPaymentStatus;
  amount: string;
  amountRefunded: string;
  currency: string;
  /** Mollie's method id (`ideal`, `creditcard`, …) once the payer chose one. */
  method: string | null;
  checkoutUrl: string | null;
  testmode: boolean;
  failureReason: string | null;
  createdAt: string;
  paidAt: string | null;
  failedAt: string | null;
  expiredAt: string | null;
}

export interface OrderRefund {
  id: string;
  paymentId: string;
  providerRefundId: string | null;
  status: OrderRefundStatus;
  amount: string;
  currency: string;
  reason: string | null;
  /** The WeldBooks credit note, once the refund went through. */
  creditNoteId: string | null;
  createdAt: string;
  refundedAt: string | null;
}

export interface OrderPayments {
  payments: OrderPayment[];
  refunds: OrderRefund[];
}

export interface RefundInput {
  amount: string;
  reason?: string;
  /** Default: the paid payment with the most refundable left. */
  paymentId?: string;
}

export interface OrderInvoiceResult {
  id: string;
  number: string | null;
  status: string;
}

export const commercePaymentKeys = {
  all: () => [...commerceKeys.all, 'payments'] as const,
  connection: () => [...commercePaymentKeys.all(), 'connection'] as const,
  profiles: () => [...commercePaymentKeys.all(), 'profiles'] as const,
  order: (orderId: string) => [...commercePaymentKeys.all(), 'order', orderId] as const,
};

/** Whether Mollie Connect (OAuth) is offered on this install, whether or not a connection exists. */
export function isOauthAvailable(res: PaymentConnectionResponse | undefined): boolean {
  return res?.data?.oauthAvailable ?? res?.meta?.oauthAvailable ?? false;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export function usePaymentConnection(enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: commercePaymentKeys.connection(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<PaymentConnectionResponse>('/commerce-payments/connection');
    },
    enabled,
  });
}

/** The Mollie profiles of an OAuth connection (to choose the one payments go through). */
export function useMollieProfiles(enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: commercePaymentKeys.profiles(),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<MollieProfile[]>>('/commerce-payments/connection/profiles');
    },
    enabled,
  });
}

/** After a connection write: the connection, the profiles and every order's payments. */
function useInvalidatePayments() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: commercePaymentKeys.all() });
  };
}

/** Asks for the Mollie Connect URL; the caller sends the member there. Nothing changes until they come back. */
export function useAuthorizeMollie() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (redirectTo?: string) => {
      const client = await getClient();
      return client.post<DataResponse<{ url: string }>>(
        '/commerce-payments/connection/mollie/authorize',
        redirectTo ? { redirectTo } : {},
      );
    },
  });
}

export function useConnectMollieApiKey() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidatePayments();
  return useMutation({
    mutationFn: async (data: MollieApiKeyInput) => {
      const client = await getClient();
      return client.post<DataResponse<PaymentConnection>>('/commerce-payments/connection/mollie/api-key', data);
    },
    onSuccess: invalidate,
  });
}

export function useUpdatePaymentConnection() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidatePayments();
  return useMutation({
    mutationFn: async (data: PaymentConnectionPatch) => {
      const client = await getClient();
      return client.patch<DataResponse<PaymentConnection>>('/commerce-payments/connection', data);
    },
    onSuccess: invalidate,
  });
}

export function useDisconnectPayments() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidatePayments();
  return useMutation({
    mutationFn: async () => {
      const client = await getClient();
      return client.delete('/commerce-payments/connection');
    },
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------------------
// An order's payments
// ---------------------------------------------------------------------------

/** The payment attempts and refunds of an order. The server reads an open payment back from Mollie on this call. */
export function useOrderPayments(orderId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: commercePaymentKeys.order(orderId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<OrderPayments>>(`/orders/${orderId}/payments`);
    },
    enabled: !!orderId && enabled,
  });
}

/** After a payment write: the order's payments, every order list and detail (status, amounts), the overview counters. */
function useInvalidateOrderPayments() {
  const qc = useQueryClient();
  return (orderId: string) => {
    void qc.invalidateQueries({ queryKey: commercePaymentKeys.order(orderId) });
    void qc.invalidateQueries({ queryKey: commerceOrderKeys.orders() });
    void qc.invalidateQueries({ queryKey: commerceKeys.overview() });
  };
}

/** A Mollie payment for what the order still owes; the result carries the checkout URL. */
export function useCreatePaymentLink() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateOrderPayments();
  return useMutation({
    mutationFn: async (orderId: string) => {
      const client = await getClient();
      return client.post<DataResponse<OrderPayment>>(`/orders/${orderId}/payment-link`, {});
    },
    onSuccess: (_res, orderId) => invalidate(orderId),
  });
}

export function useCreateRefund() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateOrderPayments();
  return useMutation({
    mutationFn: async ({ orderId, data }: { orderId: string; data: RefundInput }) => {
      const client = await getClient();
      return client.post<DataResponse<OrderRefund>>(`/orders/${orderId}/refunds`, data);
    },
    onSuccess: (_res, { orderId }) => invalidate(orderId),
  });
}

/** Tries the WeldBooks invoice of a paid order again (after `metadata.invoiceError` was set). */
export function useRetryOrderInvoice() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateOrderPayments();
  return useMutation({
    mutationFn: async (orderId: string) => {
      const client = await getClient();
      return client.post<DataResponse<OrderInvoiceResult>>(`/orders/${orderId}/invoice`, {});
    },
    onSuccess: (_res, orderId) => invalidate(orderId),
  });
}
