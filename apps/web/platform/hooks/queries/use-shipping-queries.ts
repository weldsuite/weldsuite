/**
 * WeldStash carrier shipping: carrier accounts, labels on a packed pick list
 * and parcels. Typed domain client from `@weldsuite/app-api-client`.
 *
 * The whole surface is served by the Rust backend only (Kubernetes editions),
 * so every query stays idle on Global (`isFeatureAvailable('stash-shipping')`).
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import { isFeatureAvailable } from '@/lib/edition';
import { weldstashKeys } from '@/hooks/queries/use-weldstash-queries';
import type {
  CreateCarrierInput,
  CreateLabelsInput,
  CreateReturnLabelInput,
  ListCarrierProductsQuery,
  ListParcelsQuery,
  ListServicePointsQuery,
  QuoteInput,
  UpdateCarrierInput,
} from '@weldsuite/app-api-client/schemas/shipping';

export const shippingKeys = {
  all: [...weldstashKeys.all, 'shipping'] as const,
  catalog: () => [...shippingKeys.all, 'catalog'] as const,
  carriers: () => [...shippingKeys.all, 'carriers'] as const,
  products: (carrierId: string, params: ListCarrierProductsQuery) =>
    [...shippingKeys.carriers(), carrierId, 'products', params] as const,
  servicePoints: (carrierId: string, params: ListServicePointsQuery) =>
    [...shippingKeys.carriers(), carrierId, 'service-points', params] as const,
  quote: (carrierId: string, body: QuoteInput) => [...shippingKeys.carriers(), carrierId, 'quote', body] as const,
  pickListShipping: (pickListId: string) => [...shippingKeys.all, 'pick-list', pickListId] as const,
  parcels: () => [...weldstashKeys.all, 'parcels'] as const,
  parcelList: (params: Omit<ListParcelsQuery, 'cursor'>) => [...shippingKeys.parcels(), 'list', params] as const,
  parcel: (id: string) => [...shippingKeys.parcels(), 'detail', id] as const,
};

const shippingAvailable = () => isFeatureAvailable('stash-shipping');

// ---------------------- Carrier accounts ----------------------

export function useCarrierCatalog(enabled = true) {
  const api = useAppApi();
  return useQuery({
    queryKey: shippingKeys.catalog(),
    queryFn: async () => (await api.shipping.getCatalog()).data,
    enabled: enabled && shippingAvailable(),
    staleTime: 10 * 60_000,
  });
}

export function useCarriers(enabled = true) {
  const api = useAppApi();
  return useQuery({
    queryKey: shippingKeys.carriers(),
    queryFn: async () => (await api.shipping.listCarriers()).data,
    enabled: enabled && shippingAvailable(),
  });
}

export function useCreateCarrier() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateCarrierInput) => (await api.shipping.createCarrier(data)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: shippingKeys.carriers() }),
  });
}

export function useUpdateCarrier() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateCarrierInput }) =>
      (await api.shipping.updateCarrier(id, data)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: shippingKeys.carriers() }),
  });
}

export function useDeleteCarrier() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => api.shipping.deleteCarrier(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: shippingKeys.carriers() }),
  });
}

export function useTestCarrier() {
  const api = useAppApi();
  return useMutation({
    mutationFn: async (id: string) => (await api.shipping.testCarrier(id)).data,
  });
}

// ---------------------- Products, service points, quote ----------------------

export function useCarrierProducts(carrierId: string | undefined, params: ListCarrierProductsQuery, enabled = true) {
  const api = useAppApi();
  return useQuery({
    queryKey: shippingKeys.products(carrierId ?? '', params),
    queryFn: async () => (await api.shipping.listProducts(carrierId as string, params)).data,
    enabled: enabled && !!carrierId && shippingAvailable(),
  });
}

/** Looked up when asked for (`enabled`), never on every keystroke. */
export function useServicePoints(carrierId: string | undefined, params: ListServicePointsQuery | null) {
  const api = useAppApi();
  return useQuery({
    queryKey: shippingKeys.servicePoints(carrierId ?? '', params ?? { country: '', postalCode: '' }),
    queryFn: async () => (await api.shipping.listServicePoints(carrierId as string, params as ListServicePointsQuery)).data,
    enabled: !!carrierId && !!params && shippingAvailable(),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useCarrierQuote(carrierId: string | undefined, body: QuoteInput | null) {
  const api = useAppApi();
  return useQuery({
    queryKey: shippingKeys.quote(carrierId ?? '', body ?? { toCountry: '', pieces: [] }),
    queryFn: async () => (await api.shipping.quote(carrierId as string, body as QuoteInput)).data,
    enabled: !!carrierId && !!body && shippingAvailable(),
    staleTime: 60_000,
    retry: false,
  });
}

// ---------------------- Labels on a pick list ----------------------

export function usePickListShipping(pickListId: string, enabled = true) {
  const api = useAppApi();
  return useQuery({
    queryKey: shippingKeys.pickListShipping(pickListId),
    queryFn: async () => (await api.shipping.getPickListShipping(pickListId)).data,
    enabled: enabled && !!pickListId && shippingAvailable(),
  });
}

function useInvalidateAfterLabels() {
  const qc = useQueryClient();
  return (pickListId: string) => {
    void qc.invalidateQueries({ queryKey: shippingKeys.pickListShipping(pickListId) });
    void qc.invalidateQueries({ queryKey: shippingKeys.parcels() });
    void qc.invalidateQueries({ queryKey: weldstashKeys.pickLists() });
    void qc.invalidateQueries({ queryKey: weldstashKeys.pickList(pickListId) });
  };
}

export function useCreateLabels() {
  const api = useAppApi();
  const invalidate = useInvalidateAfterLabels();
  return useMutation({
    mutationFn: async ({ pickListId, data }: { pickListId: string; data: CreateLabelsInput }) =>
      (await api.shipping.createLabels(pickListId, data)).data,
    onSuccess: (_, { pickListId }) => invalidate(pickListId),
  });
}

export function useVoidLabels() {
  const api = useAppApi();
  const invalidate = useInvalidateAfterLabels();
  return useMutation({
    mutationFn: async (pickListId: string) => (await api.shipping.voidLabels(pickListId)).data,
    onSuccess: (_, pickListId) => invalidate(pickListId),
  });
}

// ---------------------- Parcels ----------------------

export function useInfiniteParcels(params: Omit<ListParcelsQuery, 'cursor'>) {
  const api = useAppApi();
  return useInfiniteQuery({
    queryKey: shippingKeys.parcelList(params),
    queryFn: ({ pageParam }) => api.shipping.listParcels({ ...params, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.pagination?.hasMore ? (lastPage.pagination.cursor ?? undefined) : undefined,
    enabled: shippingAvailable(),
  });
}

export function useParcel(id: string, enabled = true) {
  const api = useAppApi();
  return useQuery({
    queryKey: shippingKeys.parcel(id),
    queryFn: async () => (await api.shipping.getParcel(id)).data,
    enabled: enabled && !!id && shippingAvailable(),
  });
}

export function useRefreshTracking() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.shipping.refreshTracking(id)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: shippingKeys.parcels() }),
  });
}

export function useCreateReturnLabel() {
  const api = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data?: CreateReturnLabelInput }) =>
      (await api.shipping.createReturnLabel(id, data)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: shippingKeys.parcels() }),
  });
}

/** What to do with a label or customs document once it is fetched. */
export type ParcelFileAction = 'open' | 'download';

export interface ParcelFileRequest {
  id: string;
  kind: 'label' | 'customs';
  action: ParcelFileAction;
  /** `pdf` opens in a tab; `zpl` is always downloaded. */
  format?: 'pdf' | 'zpl' | null;
  /** The file name for a download, without extension. */
  fileName?: string;
}

/** Fetches a label or customs document through the authenticated client and opens or saves it. */
export function useParcelFile() {
  const api = useAppApi();
  return useMutation({
    mutationFn: async ({ id, kind, action, format, fileName }: ParcelFileRequest) => {
      const blob = kind === 'label' ? await api.shipping.getLabelBlob(id) : await api.shipping.getCustomsDocumentBlob(id);
      const isZpl = kind === 'label' && format === 'zpl';
      const url = URL.createObjectURL(isZpl ? new Blob([blob], { type: 'text/plain' }) : new Blob([blob], { type: 'application/pdf' }));
      if (action === 'open' && !isZpl) {
        const tab = window.open(url, '_blank');
        // Give the tab time to load the file before the URL is released.
        setTimeout(() => URL.revokeObjectURL(url), tab ? 60_000 : 0);
        return;
      }
      const link = document.createElement('a');
      link.href = url;
      const baseName = fileName ?? `${kind}-${id}`;
      link.download = `${baseName}.${isZpl ? 'zpl' : 'pdf'}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  });
}
