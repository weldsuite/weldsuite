/**
 * WeldBooks document tax queries: the debounced calculation preview of the
 * invoice / credit memo / bill / recurring forms, retrying the provider sync
 * of a finalized invoice, creating a credit memo from an invoice, the
 * exemption certificates an invoice rests on, and the product picker of the
 * line items.
 *
 * Preview keys live under `['accounting', 'tax-preview']`, so the entity
 * switch resets them with the other entity-scoped accounting data.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { buildQueryString, type ListResponse } from '@weldsuite/core-api-client/types';
import { useDebounce } from '@/hooks/use-debounce';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { accountingApi } from '@/lib/api/domains/weldbooks';
import {
  salesTaxErrorCode,
  salesTaxPreviewApi,
  type ExemptionCertificateSummary,
  type SalesTaxErrorCode,
  type TaxPreviewRequest,
  type TaxPreviewResult,
} from '@/lib/api/domains/weldbooks-sales-tax-preview';
import type { ProductTaxFields } from '@/lib/weldbooks/tax-codes';
import { accountingKeys } from './use-accounting-queries';

export const taxPreviewKeys = {
  all: ['accounting', 'tax-preview'] as const,
  preview: (request: TaxPreviewRequest | null) => [...taxPreviewKeys.all, request] as const,
  certificate: (id: string) => ['accounting', 'exemption-certificates', 'detail', id] as const,
};

/** The delay between the last edit and the calculation request. */
export const TAX_PREVIEW_DEBOUNCE_MS = 400;

export interface TaxPreviewState {
  /**
   * The last calculation that succeeded (the one for the current form state
   * when `isStale` is false). Null while nothing has been calculated.
   */
  result: TaxPreviewResult | null;
  /** The form changed and the calculation for it is pending, or in flight. */
  isCalculating: boolean;
  /** The calculation for the current form state failed; `result` is the last good one. */
  error: Error | null;
  errorCode: SalesTaxErrorCode | null;
  /** `result` doesn't match the form's current state (calculating, or the last request failed). */
  isStale: boolean;
}

/**
 * The server's calculation of a draft document (`POST /sales-tax/calculate`),
 * for any jurisdiction. Debounced on the request; the last good values stay
 * on screen while the next ones load and when a request fails. `request` is
 * null while there is nothing to calculate (the forms show zero totals).
 */
export function useTaxPreview(
  request: TaxPreviewRequest | null,
  options: { enabled?: boolean; debounceMs?: number } = {},
): TaxPreviewState {
  const { enabled = true, debounceMs = TAX_PREVIEW_DEBOUNCE_MS } = options;
  const serialized = request ? JSON.stringify(request) : null;
  const debounced = useDebounce(serialized, debounceMs);
  const debouncedRequest = useMemo(
    () => (debounced ? (JSON.parse(debounced) as TaxPreviewRequest) : null),
    [debounced],
  );

  const query = useQuery({
    queryKey: taxPreviewKeys.preview(debouncedRequest),
    queryFn: async () => {
      if (!debouncedRequest) throw new Error('Nothing to calculate');
      return (await salesTaxPreviewApi.calculate(debouncedRequest)).data;
    },
    enabled: enabled && debouncedRequest !== null,
    retry: false,
    staleTime: 15_000,
  });

  // The last good answer: kept across the pending state of the next request and across failures.
  const [lastGood, setLastGood] = useState<TaxPreviewResult | null>(null);
  if (query.data && query.data !== lastGood) setLastGood(query.data);
  if (serialized === null && lastGood !== null) setLastGood(null);

  const active = enabled && serialized !== null;
  const waiting = active && (serialized !== debounced || query.isFetching);
  const error = active && !waiting ? (query.error ?? null) : null;
  const result = active ? (query.data ?? lastGood) : null;

  return {
    result,
    isCalculating: waiting,
    error,
    errorCode: salesTaxErrorCode(error),
    isStale: waiting || error !== null,
  };
}

/** Retry recording a finalized invoice (or a credit memo's reversal) with the provider engine. */
export function useCommitInvoiceTax() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (invoiceId: string) => salesTaxPreviewApi.commitInvoiceTax(invoiceId),
    onSuccess: (_, invoiceId) => {
      qc.invalidateQueries({ queryKey: accountingKeys.invoices.detail(invoiceId) });
      qc.invalidateQueries({ queryKey: accountingKeys.invoices.lists() });
    },
  });
}

/** A draft credit memo that mirrors a finalized invoice; its tax follows the invoice line by line. */
export function useCreateCreditMemo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (invoiceId: string) => accountingApi.createCreditNote(invoiceId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: accountingKeys.invoices.all });
    },
  });
}

/**
 * The exemption certificates named by a document's breakdown, for the number
 * the exempt notice prints. A certificate the user can't read (`taxes:read`)
 * is left out; the notice then has no number.
 */
export function useExemptionCertificates(ids: readonly string[]): Map<string, ExemptionCertificateSummary> {
  // `combine` hands back a plain array that is structurally shared, so the memo below only changes with the data.
  const certificates = useQueries({
    queries: ids.map((id) => ({
      queryKey: taxPreviewKeys.certificate(id),
      queryFn: async () => (await salesTaxPreviewApi.getExemptionCertificate(id)).data,
      retry: false,
      staleTime: 5 * 60_000,
    })),
    combine: (results) => results.flatMap((result) => (result.data ? [result.data] : [])),
  });
  return useMemo(() => new Map(certificates.map((certificate) => [certificate.id, certificate])), [certificates]);
}

// ============================================================================
// Product picker
// ============================================================================

/** A catalogue product as the line picker needs it. */
export interface ProductOption extends ProductTaxFields {
  id: string;
  name: string;
  sku?: string | null;
  price?: number | null;
}

type ProductRow = ProductOption & { status?: string };

const PRODUCT_PICKER_LIMIT = 100;

function toOption(row: ProductRow): ProductOption {
  return {
    id: row.id,
    name: row.name,
    sku: row.sku ?? null,
    price: row.price ?? null,
    taxClass: row.taxClass ?? null,
    taxable: row.taxable ?? null,
  };
}

/**
 * The first page of the catalogue for the line items' product picker (sales
 * tax entities only: the product's tax class sets the line's tax code).
 */
export function useProductOptions(enabled: boolean) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: ['weldcommerce', 'products', 'invoice-picker'] as const,
    enabled,
    staleTime: 60_000,
    queryFn: async () => {
      const client = await getClient();
      const qs = buildQueryString({ limit: PRODUCT_PICKER_LIMIT, status: 'active' });
      const res = await client.get<ListResponse<ProductRow>>(`/products${qs}`);
      return (res.data ?? []).map(toOption);
    },
  });
}

/** Server-side product search for the picker (a catalogue bigger than its first page). */
export function useProductSearch() {
  const { getClient } = useAppApiClient();
  return async (search: string): Promise<ProductOption[]> => {
    const client = await getClient();
    const qs = buildQueryString({ limit: 25, status: 'active', search });
    const res = await client.get<ListResponse<ProductRow>>(`/products${qs}`);
    return (res.data ?? []).map(toOption);
  };
}
