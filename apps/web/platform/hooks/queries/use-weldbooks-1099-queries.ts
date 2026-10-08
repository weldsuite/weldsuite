/**
 * WeldBooks 1099 queries and mutations: the yearly review, filings and their
 * lines, TIN matching, Form 945, online W-9 requests and vendor bank
 * verification.
 *
 * Keys live under `['accounting', 'form-1099', ...]`, so the entity switch
 * resets them with the other entity-scoped accounting data
 * (`isEntityScopedAccountingQuery`): a filing belongs to one entity.
 *
 * Calls that return a full TIN, a bank account number or a one-time W-9 link
 * (`useOneShotAction`) never go through the query or mutation cache: the
 * result goes to the caller and nowhere else.
 */
import { useCallback, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  form1099Api,
  vendorTaxApi,
  w9RequestsApi,
  type Form1099Filing,
  type Form1099FilingDetail,
  type Form1099FilingStatus,
  type Form1099Type,
  type LinePatch,
  type CorrectLineInput,
  type W9RequestStatus,
} from '@/lib/api/domains/weldbooks-1099';
import { accountingKeys } from '@/hooks/queries/use-accounting-queries';

export const form1099Keys = {
  all: ['accounting', 'form-1099'] as const,
  summary: (year: number) => [...form1099Keys.all, 'summary', year] as const,
  vendorDetail: (partyId: string, year: number) => [...form1099Keys.all, 'vendor', partyId, year] as const,
  deadlines: (year: number) => [...form1099Keys.all, 'deadlines', year] as const,
  form945: (year: number) => [...form1099Keys.all, '945', year] as const,
  filings: () => [...form1099Keys.all, 'filings'] as const,
  filingList: (filter?: { year?: number; formType?: Form1099Type; status?: Form1099FilingStatus }) =>
    [...form1099Keys.filings(), 'list', filter ?? {}] as const,
  filing: (id: string) => [...form1099Keys.filings(), 'detail', id] as const,
  w9Requests: (partyId?: string, status?: W9RequestStatus) =>
    [...form1099Keys.all, 'w9-requests', partyId ?? 'all', status ?? 'any'] as const,
  reveals: (partyId: string) => [...form1099Keys.all, 'reveals', partyId] as const,
};

/** Contacts shown on the supplier list and the 1099 review share their rows with the contact queries. */
function invalidateContacts(qc: QueryClient, partyId?: string) {
  qc.invalidateQueries({ queryKey: accountingKeys.customers.all });
  if (partyId) qc.invalidateQueries({ queryKey: accountingKeys.customers.detail(partyId) });
}

/** What changes in the review when a vendor's tax data does. */
export function invalidateForm1099Review(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: [...form1099Keys.all, 'summary'] });
  qc.invalidateQueries({ queryKey: [...form1099Keys.all, 'vendor'] });
}

// ============================================================================
// One-shot actions
// ============================================================================

/**
 * Runs an async call whose result is sensitive (a TIN, an account number, the
 * IRIS file, a one-time link). Tracks `isPending` and the last error, and
 * hands the result to the caller only: no cache, no state.
 */
export function useOneShotAction<TArgs extends unknown[], TResult>(action: (...args: TArgs) => Promise<TResult>) {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const actionRef = useRef(action);
  actionRef.current = action;

  const run = useCallback(async (...args: TArgs): Promise<TResult> => {
    setIsPending(true);
    setError(null);
    try {
      return await actionRef.current(...args);
    } catch (err) {
      const failure = err instanceof Error ? err : new Error('Request failed');
      setError(failure);
      throw failure;
    } finally {
      setIsPending(false);
    }
  }, []);

  const reset = useCallback(() => setError(null), []);
  return { run, isPending, error, reset };
}

export function useRevealTin(partyId: string) {
  return useOneShotAction(async (reason?: string) => (await vendorTaxApi.revealTin(partyId, reason)).data);
}

export function useRevealAchAccount(partyId: string) {
  return useOneShotAction(async (reason?: string) => (await vendorTaxApi.revealAchAccount(partyId, reason)).data);
}

/** The IRIS upload files of a filing (full TINs; the server logs one reveal per recipient). */
export function useIrisFiles() {
  return useOneShotAction(
    async (filingId: string, templateHeaders?: string[] | string) =>
      (await form1099Api.irisFiles(filingId, templateHeaders)).data,
  );
}

/** The IRS TIN matching upload files (full TINs; the server logs one reveal per vendor). */
export function useTinMatchingFile() {
  return useOneShotAction(
    async (params: { all?: boolean; partyIds?: string[] } = {}) => (await form1099Api.tinMatchingFile(params)).data,
  );
}

// ============================================================================
// Review
// ============================================================================

export function useForm1099Summary(year: number, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: form1099Keys.summary(year),
    queryFn: async () => (await form1099Api.summary(year)).data,
    enabled: options.enabled ?? true,
    // A vendor edited in another screen changes the review: look again on every visit.
    refetchOnMount: 'always',
  });
}

export function useForm1099VendorDetail(partyId: string | null | undefined, year: number) {
  return useQuery({
    queryKey: form1099Keys.vendorDetail(partyId ?? '', year),
    queryFn: async () => (await form1099Api.vendorDetail(partyId!, year)).data,
    enabled: !!partyId,
  });
}

export function useForm1099Deadlines(year: number) {
  return useQuery({
    queryKey: form1099Keys.deadlines(year),
    queryFn: async () => (await form1099Api.deadlines(year)).data,
    staleTime: 60 * 60 * 1000,
  });
}

export function useForm945(year: number, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: form1099Keys.form945(year),
    queryFn: async () => (await form1099Api.form945(year)).data,
    enabled: options.enabled ?? true,
  });
}

/**
 * The supplier list with each vendor's tax status. Kept under the contact
 * list keys, so every contact mutation refreshes it; `only1099` asks the
 * server for the vendors flagged for 1099 reporting.
 */
export function useSupplierContacts(options: { search?: string; role?: 'supplier' | 'both'; only1099?: boolean } = {}) {
  return useQuery({
    queryKey: [...accountingKeys.customers.lists(), 'suppliers', options] as const,
    queryFn: () =>
      vendorTaxApi.listContacts({
        role: options.role ?? 'supplier',
        search: options.search || undefined,
        is1099Vendor: options.only1099 ? true : undefined,
        pageSize: 100,
      }),
  });
}

// ============================================================================
// TIN matching
// ============================================================================

export function useApplyTinMatchingResults() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (text: string) => (await form1099Api.tinMatchingResults(text)).data,
    onSuccess: () => {
      invalidateForm1099Review(qc);
      invalidateContacts(qc);
    },
  });
}

// ============================================================================
// Filings
// ============================================================================

export function useForm1099Filings(filter?: { year?: number; formType?: Form1099Type; status?: Form1099FilingStatus }) {
  return useQuery({
    queryKey: form1099Keys.filingList(filter),
    queryFn: async () => (await form1099Api.listFilings(filter)).data,
  });
}

export function useForm1099Filing(id: string | undefined) {
  return useQuery({
    queryKey: form1099Keys.filing(id ?? ''),
    queryFn: async () => (await form1099Api.getFiling(id!)).data,
    enabled: !!id,
  });
}

/** Keep the open filing in step with what a mutation answered, and refresh the lists that count it. */
function applyFilingDetail(qc: QueryClient, detail: Form1099FilingDetail) {
  qc.setQueryData<Form1099FilingDetail>(form1099Keys.filing(detail.filing.id), {
    filing: detail.filing,
    lines: detail.lines,
  });
  qc.invalidateQueries({ queryKey: [...form1099Keys.filings(), 'list'] });
}

export function useCreateForm1099Filing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { taxYear: number; formType: Form1099Type }) => (await form1099Api.createFiling(input)).data,
    onSuccess: (detail) => applyFilingDetail(qc, detail),
  });
}

export function useDeleteForm1099Filing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => form1099Api.deleteFiling(id),
    onSuccess: (_, id) => {
      qc.removeQueries({ queryKey: form1099Keys.filing(id) });
      qc.invalidateQueries({ queryKey: [...form1099Keys.filings(), 'list'] });
    },
  });
}

export function useUpdateForm1099FilingNotes(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (notes: string | null) => (await form1099Api.updateFiling(id, { notes })).data,
    onSuccess: (detail) => applyFilingDetail(qc, detail),
  });
}

export function useRefreshForm1099Filing(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await form1099Api.refreshFiling(id)).data,
    onSuccess: (result) => applyFilingDetail(qc, result),
  });
}

export function useUpdateForm1099Line(filingId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { lineId: string; patch: LinePatch }) =>
      (await form1099Api.updateLine(filingId, input.lineId, input.patch)).data,
    onSuccess: (detail) => applyFilingDetail(qc, detail),
  });
}

export function useReviewForm1099Filing(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await form1099Api.reviewFiling(id)).data,
    onSuccess: (result) => applyFilingDetail(qc, result),
  });
}

export function useGenerateForm1099Filing(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await form1099Api.generateFiling(id)).data,
    onSuccess: (detail) => applyFilingDetail(qc, detail),
  });
}

export function useMarkForm1099Filed(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { confirmationNumber: string; filedAt?: string }) => (await form1099Api.markFiled(id, input)).data,
    onSuccess: (detail) => applyFilingDetail(qc, detail),
  });
}

export function useCorrectForm1099Line(filingId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { lineId: string; correction: CorrectLineInput }) =>
      (await form1099Api.correctLine(filingId, input.lineId, input.correction)).data,
    onSuccess: (result) => applyFilingDetail(qc, result),
  });
}

export function useMarkForm1099Delivered(filingId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { lineId: string; method: 'print' | 'email' }) =>
      (await form1099Api.markDelivered(filingId, input.lineId, input.method)).data,
    onSuccess: (result) => applyFilingDetail(qc, result),
  });
}

/** A filing as the list returns it, for places that only need its headline numbers. */
export type Form1099FilingSummary = Form1099Filing;

// ============================================================================
// Online W-9 and vendor bank verification
// ============================================================================

export function useW9Requests(partyId: string | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: form1099Keys.w9Requests(partyId),
    queryFn: async () => (await w9RequestsApi.list({ partyId })).data,
    enabled: (options.enabled ?? true) && !!partyId,
  });
}

/** Creates the request. The result carries the one-time link, so it goes to the caller only. */
export function useCreateW9Request() {
  const qc = useQueryClient();
  const action = useOneShotAction(async (input: { partyId: string; email?: string; expiresInDays?: number }) => {
    const result = (await w9RequestsApi.create(input)).data;
    qc.invalidateQueries({ queryKey: [...form1099Keys.all, 'w9-requests'] });
    return result;
  });
  return action;
}

export function useCancelW9Request() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await w9RequestsApi.cancel(id)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: [...form1099Keys.all, 'w9-requests'] }),
  });
}

export function useVerifyBankDetails(partyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await vendorTaxApi.verifyBankDetails(partyId)).data,
    onSuccess: () => invalidateContacts(qc, partyId),
  });
}

/** Who looked at this vendor's TIN or account number (people with `tax_ids:reveal`). */
export function useTaxIdReveals(partyId: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: form1099Keys.reveals(partyId),
    queryFn: async () => (await vendorTaxApi.listReveals(partyId)).data,
    enabled: (options.enabled ?? true) && !!partyId,
    // The log should never be served from a stale cache.
    gcTime: 0,
  });
}
