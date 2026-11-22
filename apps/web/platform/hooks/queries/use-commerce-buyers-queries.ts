/**
 * WeldCommerce phase 6 query hooks: the buyers of a CRM company, the company's
 * approval threshold, and the staff decision on an order that waits for
 * approval. Served by the Rust `commerce` module (EU edition); the contract is
 * `/commerce-buyers`, `/commerce-company-settings/:companyId` and
 * `/orders/:id/approve|reject`.
 *
 * - Buyers:    GET /commerce-buyers?companyId=&personId=, POST, PATCH /:id,
 *              DELETE /:id, POST /:id/invite (send the invitation again)
 * - Settings:  GET / PUT /commerce-company-settings/:companyId
 * - Approvals: POST /orders/:id/approve and /reject, `{ comment? }`
 *
 * Keys: buyers sit under `['weldcommerce', 'buyers']` (the `commerce_buyer`
 * realtime event invalidates that prefix) and a company's settings under
 * `['weldcommerce', 'company-settings', companyId]` (`commerce_company_settings`).
 * Money is a decimal string with two decimals; `null` clears an optional field.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { DataResponse } from '@weldsuite/core-api-client/types';
import { buildQueryString } from '@weldsuite/core-api-client/types';
import { commerceKeys } from '@/hooks/queries/use-commerce-queries';
import { commerceOrderKeys, type Order } from '@/hooks/queries/use-commerce-orders-queries';
import { commercePaymentKeys } from '@/hooks/queries/use-commerce-payments-queries';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BuyerRole = 'buyer' | 'approver' | 'admin';
export type BuyerStatus = 'invited' | 'active' | 'disabled';

export interface Buyer {
  id: string;
  personId: string;
  companyId: string;
  name: string | null;
  email: string;
  role: BuyerRole;
  /** A decimal string; orders above it wait for approval. */
  spendLimit: string | null;
  spendLimitCurrency: string | null;
  status: BuyerStatus;
  invitedAt: string | null;
  acceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BuyerListParams {
  companyId?: string;
  personId?: string;
}

export interface BuyerInput {
  companyId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: BuyerRole;
  spendLimit?: string | null;
  spendLimitCurrency?: string | null;
  /** Email the invitation now (the API's default is yes). */
  sendInvite?: boolean;
}

export interface BuyerPatch {
  role?: BuyerRole;
  spendLimit?: string | null;
  spendLimitCurrency?: string | null;
  status?: BuyerStatus;
}

/** What a company's orders are held for: a total above this amount waits for approval. */
export interface CompanyCommerceSettings {
  companyId: string;
  approvalThreshold: string | null;
  approvalThresholdCurrency: string | null;
}

export interface CompanyCommerceSettingsInput {
  approvalThreshold: string | null;
  approvalThresholdCurrency: string | null;
}

export interface ApprovalDecisionInput {
  comment?: string;
}

export const commerceBuyerKeys = {
  all: () => [...commerceKeys.all, 'buyers'] as const,
  list: (params?: BuyerListParams) => [...commerceBuyerKeys.all(), 'list', params ?? {}] as const,
  companySettings: (companyId: string) => [...commerceKeys.all, 'company-settings', companyId] as const,
};

// ---------------------------------------------------------------------------
// Buyers
// ---------------------------------------------------------------------------

/** The buyers of a company (or the companies of a person); the list is not paged. */
export function useCommerceBuyers(params: BuyerListParams, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: commerceBuyerKeys.list(params),
    queryFn: async () => {
      const client = await getClient();
      const qs = buildQueryString({ ...params } as Record<string, unknown>);
      return client.get<DataResponse<Buyer[]>>(`/commerce-buyers${qs}`);
    },
    enabled: enabled && !!(params.companyId || params.personId),
  });
}

/** After a buyer write: every buyer list. */
function useInvalidateBuyers() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: commerceBuyerKeys.all() });
  };
}

export function useInviteCommerceBuyer() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateBuyers();
  return useMutation({
    mutationFn: async (data: BuyerInput) => {
      const client = await getClient();
      return client.post<DataResponse<Buyer>>('/commerce-buyers', data);
    },
    onSuccess: invalidate,
  });
}

export function useUpdateCommerceBuyer() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateBuyers();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: BuyerPatch }) => {
      const client = await getClient();
      return client.patch<DataResponse<Buyer>>(`/commerce-buyers/${id}`, data);
    },
    onSuccess: invalidate,
  });
}

export function useDeleteCommerceBuyer() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateBuyers();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.delete(`/commerce-buyers/${id}`);
    },
    onSuccess: invalidate,
  });
}

/** Sends the invitation of a buyer again; the buyer's `invitedAt` moves. */
export function useResendCommerceBuyerInvite() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateBuyers();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      return client.post(`/commerce-buyers/${id}/invite`, {});
    },
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------------------
// Company settings (the approval threshold)
// ---------------------------------------------------------------------------

export function useCompanyCommerceSettings(companyId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: commerceBuyerKeys.companySettings(companyId),
    queryFn: async () => {
      const client = await getClient();
      return client.get<DataResponse<CompanyCommerceSettings>>(`/commerce-company-settings/${companyId}`);
    },
    enabled: !!companyId && enabled,
  });
}

export function useUpdateCompanyCommerceSettings(companyId: string) {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: CompanyCommerceSettingsInput) => {
      const client = await getClient();
      return client.put<DataResponse<CompanyCommerceSettings>>(`/commerce-company-settings/${companyId}`, data);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: commerceBuyerKeys.companySettings(companyId) }),
  });
}

// ---------------------------------------------------------------------------
// Order approvals
// ---------------------------------------------------------------------------

/**
 * After an approval decision: the order and every order list (status, badges),
 * the overview counters, and the order's payments (an approval can start one).
 */
function useInvalidateApproval() {
  const qc = useQueryClient();
  return (orderId: string) => {
    void qc.invalidateQueries({ queryKey: commerceOrderKeys.orders() });
    void qc.invalidateQueries({ queryKey: commerceKeys.overview() });
    void qc.invalidateQueries({ queryKey: commercePaymentKeys.order(orderId) });
  };
}

/** Staff override of a pending approval: releases the order (invoice, payment, warehouse follow). */
export function useApproveCommerceOrder() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateApproval();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data?: ApprovalDecisionInput }) => {
      const client = await getClient();
      return client.post<DataResponse<Order>>(`/orders/${id}/approve`, data ?? {});
    },
    // Settled, not only successful: a 409 NOT_PENDING means another decision came first, so the screen is stale.
    onSettled: (_res, _err, { id }) => invalidate(id),
  });
}

/** Staff rejection of a pending approval: the order is cancelled. */
export function useRejectCommerceOrder() {
  const { getClient } = useAppApiClient();
  const invalidate = useInvalidateApproval();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data?: ApprovalDecisionInput }) => {
      const client = await getClient();
      return client.post<DataResponse<Order>>(`/orders/${id}/reject`, data ?? {});
    },
    // Settled, not only successful: a 409 NOT_PENDING means another decision came first, so the screen is stale.
    onSettled: (_res, _err, { id }) => invalidate(id),
  });
}
