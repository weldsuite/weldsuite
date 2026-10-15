/**
 * Brazil: the monthly apuração, the ECD export, the withholding suggestion,
 * and the electronic fiscal documents (NF-e / NFS-e) with the NF-e inbox.
 *
 * Every key sits under `['accounting']`, so switching the accounting entity
 * resets them with the other entity-scoped data. The fiscal document keys
 * match `lib/realtime/sync-map.ts`, which refreshes them on provider webhooks.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  brTaxApi,
  type EcdSignatory,
  type WithholdingServiceKind,
} from '@/lib/api/domains/weldbooks-br';
import {
  fiscalDocumentsApi,
  receivedFiscalDocumentsApi,
  type CreateBillFromReceivedInput,
  type ManifestationType,
  type ReceivedStatus,
  type UpdateFiscalSettingsInput,
} from '@/lib/api/domains/weldbooks-fiscal-documents';

export const brKeys = {
  apuracao: (period: string) => ['accounting', 'br-apuracao', period] as const,
  apuracaoAll: ['accounting', 'br-apuracao'] as const,
};

export const fiscalDocumentKeys = {
  all: ['accounting', 'fiscal-documents'] as const,
  settings: () => [...fiscalDocumentKeys.all, 'settings'] as const,
  forInvoice: (invoiceId: string) => [...fiscalDocumentKeys.all, 'invoice', invoiceId] as const,
};

export const receivedFiscalDocumentKeys = {
  all: ['accounting', 'received-fiscal-documents'] as const,
  list: (status?: ReceivedStatus) => [...receivedFiscalDocumentKeys.all, 'list', status ?? 'all'] as const,
};

export function isValidApuracaoPeriod(period: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(period);
}

/** The apuração of a month (YYYY-MM), for the selected entity. */
export function useBrApuracao(period: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: brKeys.apuracao(period),
    enabled: (options.enabled ?? true) && isValidApuracaoPeriod(period),
    queryFn: async () => (await brTaxApi.apuracao(period)).data,
    retry: false,
  });
}

/** Book the month's obligations as a tax return and a journal entry. */
export function useBookBrApuracao() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (period: string) => (await brTaxApi.bookApuracao(period)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: brKeys.apuracaoAll });
      qc.invalidateQueries({ queryKey: ['accounting', 'journal-entries'] });
      qc.invalidateQueries({ queryKey: ['accounting', 'tax-returns'] });
    },
  });
}

/** Download the SPED ECD of a year. The file goes to the caller; nothing is cached. */
export function useExportEcd() {
  return useMutation({
    mutationFn: ({ year, signatories }: { year: number; signatories: EcdSignatory[] }) =>
      brTaxApi.ecd(year, signatories),
  });
}

/** The withholdings usually applied to a customer's services (a suggestion, never saved). */
export function useSuggestBrWithholdings() {
  return useMutation({
    mutationFn: async (params: { contactId?: string | null; serviceKind?: WithholdingServiceKind }) =>
      (await brTaxApi.suggestWithholdings(params)).data,
  });
}

// ============================================================================
// Fiscal documents
// ============================================================================

export function useFiscalSettings(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: fiscalDocumentKeys.settings(),
    enabled: options.enabled ?? true,
    queryFn: async () => (await fiscalDocumentsApi.settings()).data,
  });
}

export function useUpdateFiscalSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: UpdateFiscalSettingsInput) => (await fiscalDocumentsApi.updateSettings(data)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: fiscalDocumentKeys.settings() });
      qc.invalidateQueries({ queryKey: ['accounting', 'entities'] });
    },
  });
}

/** The fiscal documents (NF-e / NFS-e, newest first) of an invoice. */
export function useInvoiceFiscalDocuments(invoiceId: string | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: fiscalDocumentKeys.forInvoice(invoiceId ?? ''),
    enabled: Boolean(invoiceId) && (options.enabled ?? true),
    queryFn: async () => (await fiscalDocumentsApi.list({ sourceType: 'invoice', sourceId: invoiceId })).data,
    // The provider answers asynchronously (webhooks, or a refresh): poll while a document is still processing.
    refetchInterval: (query) => (query.state.data?.some((doc) => doc.status === 'processing') ? 8000 : false),
  });
}

function useFiscalDocumentMutation<TInput, TResult>(mutationFn: (input: TInput) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: () => {
      qc.invalidateQueries({ queryKey: fiscalDocumentKeys.all });
      qc.invalidateQueries({ queryKey: ['accounting', 'invoices'] });
    },
  });
}

export function useIssueFiscalDocument() {
  return useFiscalDocumentMutation(async (invoiceId: string) => (await fiscalDocumentsApi.issue(invoiceId)).data);
}

export function useRefreshFiscalDocument() {
  return useFiscalDocumentMutation(async (id: string) => (await fiscalDocumentsApi.refresh(id)).data);
}

export function useCancelFiscalDocument() {
  return useFiscalDocumentMutation(
    async ({ id, reason }: { id: string; reason: string }) => (await fiscalDocumentsApi.cancel(id, reason)).data,
  );
}

export function useCorrectFiscalDocument() {
  return useFiscalDocumentMutation(
    async ({ id, text }: { id: string; text: string }) => (await fiscalDocumentsApi.correction(id, text)).data,
  );
}

// ============================================================================
// Received NF-e
// ============================================================================

export function useReceivedFiscalDocuments(status?: ReceivedStatus) {
  return useQuery({
    queryKey: receivedFiscalDocumentKeys.list(status),
    queryFn: () => receivedFiscalDocumentsApi.list({ status }),
  });
}

function useReceivedMutation<TInput, TResult>(mutationFn: (input: TInput) => Promise<TResult>, alsoBills = false) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: receivedFiscalDocumentKeys.all });
      if (alsoBills) qc.invalidateQueries({ queryKey: ['accounting', 'bills'] });
    },
  });
}

export function useSyncReceivedFiscalDocuments() {
  return useReceivedMutation(async () => (await receivedFiscalDocumentsApi.sync()).data);
}

export function useUploadReceivedFiscalDocument() {
  return useReceivedMutation(async (xml: string) => (await receivedFiscalDocumentsApi.upload(xml)).data);
}

export function useManifestReceivedFiscalDocument() {
  return useReceivedMutation(
    async ({ id, type, reason }: { id: string; type: ManifestationType; reason?: string }) =>
      (await receivedFiscalDocumentsApi.manifest(id, type, reason)).data,
  );
}

export function useCreateBillFromReceived() {
  return useReceivedMutation(
    async ({ id, ...input }: { id: string } & CreateBillFromReceivedInput) =>
      (await receivedFiscalDocumentsApi.createBill(id, input)).data,
    true,
  );
}

export function useIgnoreReceivedFiscalDocument() {
  return useReceivedMutation(async (id: string) => (await receivedFiscalDocumentsApi.ignore(id)).data);
}
