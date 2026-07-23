/**
 * Phone-number porting hooks — app-api `/api/porting/*`.
 *
 * Migrated off the legacy api-worker (`/api/settings/telephony/port-orders/*`)
 * in W5. Envelope is app-api's `{ data: T }`; every hook keeps its previous
 * return contract so the port wizard needs no shape changes.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-react';
import { useAppApiClient } from '@/lib/api/use-app-api';

const APP_API_URL = import.meta.env.VITE_APP_API_URL || 'http://localhost:8789';

// =============================================================================
// Types
// =============================================================================

export type PortingOrderStatus =
  | 'draft'
  | 'preflight_failed'
  | 'awaiting_documents'
  | 'submitted'
  | 'in_process'
  | 'exception'
  | 'cancelled'
  | 'completed';

export interface ServiceAddress {
  line1: string;
  line2?: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}

export interface PortingOrder {
  id: string;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string;
  phoneNumber: string;
  formattedNumber?: string | null;
  countryCode: string;
  numberType: 'local' | 'mobile';
  telnyxPortingOrderId?: string | null;
  status: PortingOrderStatus;
  substatus?: string | null;
  requestedFocAt?: string | null;
  actualFocAt?: string | null;
  authorizedName?: string | null;
  businessName?: string | null;
  serviceAddress?: ServiceAddress | null;
  currentCarrier?: string | null;
  currentAccountNumber?: string | null;
  currentPin?: string | null;
  loaStorageKey?: string | null;
  billCopyStorageKey?: string | null;
  stripePriceId?: string | null;
  billingActivated?: boolean;
  billingError?: string | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  voipPhoneNumberId?: string | null;
}

export interface PreflightResult {
  portable: boolean;
  reasons: string[];
}

/** app-api single envelope. */
interface Envelope<T> {
  data: T;
}

// =============================================================================
// Query keys
// =============================================================================

const portingKeys = {
  all: ['porting'] as const,
  list: () => [...portingKeys.all, 'list'] as const,
  detail: (id: string) => [...portingKeys.all, 'detail', id] as const,
};

// =============================================================================
// Queries
// =============================================================================

export function usePortingOrders() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: portingKeys.list(),
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<Envelope<{ orders: PortingOrder[] }>>('/porting');
      return result.data?.orders ?? [];
    },
  });
}

export function usePortingOrder(id: string | undefined) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: portingKeys.detail(id ?? ''),
    enabled: !!id,
    queryFn: async () => {
      const client = await getClient();
      const result = await client.get<Envelope<{ order: PortingOrder }>>(`/porting/${id}`);
      return result.data?.order ?? null;
    },
  });
}

// =============================================================================
// Mutations
// =============================================================================

export function usePreflightCheck() {
  const { getClient } = useAppApiClient();
  return useMutation({
    mutationFn: async (args: { phoneNumber: string; countryCode: string }) => {
      const client = await getClient();
      const result = await client.post<Envelope<PreflightResult>>('/porting/preflight', args);
      return result.data ?? { portable: false, reasons: [] };
    },
  });
}

export function useCreatePortingOrder() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      phoneNumber: string;
      formattedNumber?: string;
      countryCode: string;
      numberType: 'local' | 'mobile';
    }) => {
      const client = await getClient();
      const result = await client.post<Envelope<{ order: PortingOrder }>>('/porting', args);
      return result.data?.order;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: portingKeys.list() });
    },
  });
}

export function useUpdatePortingOrder(id: string | undefined) {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: Partial<{
      authorizedName: string;
      businessName: string;
      serviceAddress: ServiceAddress;
      currentCarrier: string;
      currentAccountNumber: string;
      currentPin: string | null;
      requestedFocAt: string;
    }>) => {
      if (!id) throw new Error('Order id required');
      const client = await getClient();
      const result = await client.patch<Envelope<{ order: PortingOrder }>>(`/porting/${id}`, args);
      return result.data?.order;
    },
    onSuccess: () => {
      if (id) qc.invalidateQueries({ queryKey: portingKeys.detail(id) });
      qc.invalidateQueries({ queryKey: portingKeys.list() });
    },
  });
}

export function useUploadPortDoc(id: string | undefined, type: 'loa' | 'bill') {
  // `postForm` sends FormData without a Content-Type so fetch fills in the
  // multipart boundary itself — no need to bypass the client any more.
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      if (!id) throw new Error('Order id required');
      const client = await getClient();

      const form = new FormData();
      form.append('file', file);

      const path = type === 'loa' ? `/porting/${id}/loa` : `/porting/${id}/bill-copy`;
      const result = await client.postForm<Envelope<{ storageKey: string }>>(path, form);
      return result.data;
    },
    onSuccess: () => {
      if (id) qc.invalidateQueries({ queryKey: portingKeys.detail(id) });
    },
  });
}

/**
 * Downloads the carrier LOA template as a PDF blob.
 *
 * app-api serves this as `POST /porting/:id/loa-template` returning raw
 * `application/pdf` (the legacy worker used GET). `ClientApi` has `getRaw` but
 * no `postRaw`, so this issues an authenticated fetch directly.
 */
export function useDownloadLoaTemplate(id: string | undefined) {
  const { getToken } = useAuth();
  return useMutation({
    mutationFn: async () => {
      if (!id) throw new Error('Order id required');
      const token = await getToken();
      if (!token) throw new Error('Not authenticated');

      const response = await fetch(`${APP_API_URL}/api/porting/${id}/loa-template`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        const err = await response.json().catch(() => null) as
          | { error?: { message?: string } }
          | null;
        throw new Error(err?.error?.message || `Failed to fetch template (${response.status})`);
      }

      return response.blob();
    },
  });
}

export function useSubmitPortingOrder(id: string | undefined) {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!id) throw new Error('Order id required');
      const client = await getClient();
      // app-api nests both outcomes under `data`; flatten to the shape the
      // wizard has always consumed (`requiresCheckout` / `checkoutUrl` / `order`).
      const result = await client.post<Envelope<{
        requiresCheckout?: boolean;
        checkoutUrl?: string;
        order?: PortingOrder;
      }>>(`/porting/${id}/submit`, {});
      return {
        requiresCheckout: result.data?.requiresCheckout,
        checkoutUrl: result.data?.checkoutUrl,
        data: result.data?.order ? { order: result.data.order } : undefined,
      };
    },
    onSuccess: () => {
      if (id) qc.invalidateQueries({ queryKey: portingKeys.detail(id) });
      qc.invalidateQueries({ queryKey: portingKeys.list() });
    },
  });
}

export function useRefreshPortingOrder(id: string | undefined) {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!id) throw new Error('Order id required');
      const client = await getClient();
      const result = await client.post<Envelope<{ order: PortingOrder }>>(
        `/porting/${id}/refresh`,
        {},
      );
      return result.data?.order;
    },
    onSuccess: () => {
      if (id) qc.invalidateQueries({ queryKey: portingKeys.detail(id) });
    },
  });
}

export function useCancelPortingOrder() {
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const client = await getClient();
      await client.delete(`/porting/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: portingKeys.list() });
    },
  });
}
