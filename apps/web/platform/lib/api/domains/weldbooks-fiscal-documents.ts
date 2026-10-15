/**
 * WeldBooks Brazil: electronic fiscal documents issued through Focus NFe
 * (`/api/fiscal-documents`) and the NF-e received from suppliers
 * (`/api/received-fiscal-documents`), books-api.
 *
 *   GET  /fiscal-documents/settings            provider, environment, token stored?, webhook state
 *   PUT  /fiscal-documents/settings            environment, Focus company token (write-only), NFS-e standard
 *   GET  /fiscal-documents?sourceType=&sourceId=&status=&kind=
 *   GET  /fiscal-documents/:id                 one document with its request / response payloads
 *   POST /fiscal-documents/issue               { invoiceId }
 *   POST /fiscal-documents/:id/refresh
 *   POST /fiscal-documents/:id/cancel          { reason } (15 to 255 characters)
 *   POST /fiscal-documents/:id/correction      { text } carta de correção, NF-e only (15 to 1000)
 *
 *   POST /received-fiscal-documents/sync       fetch the NF-e issued to the entity from the provider
 *   POST /received-fiscal-documents/upload     { xml } an NF-e XML file
 *   GET  /received-fiscal-documents?status=new|imported|ignored
 *   GET  /received-fiscal-documents/:id
 *   POST /received-fiscal-documents/:id/manifest      { type, reason? } manifestação do destinatário
 *   POST /received-fiscal-documents/:id/create-bill   { contactId? }
 *   POST /received-fiscal-documents/:id/ignore
 */
import { weldbooksApi } from '../weldbooks-client';

export type FiscalDocumentKind = 'nfe' | 'nfse' | 'nfsen';
export type FiscalDocumentStatus = 'processing' | 'authorized' | 'rejected' | 'cancelled' | 'error';
export type FiscalEnvironment = 'homologacao' | 'producao';

/** A fiscal document of an invoice, without its payloads (those only come with the detail). */
export interface FiscalDocument {
  id: string;
  entityId: string;
  sourceType: 'invoice' | 'credit_note' | string;
  sourceId: string;
  kind: FiscalDocumentKind;
  provider: string;
  providerRef: string;
  environment: FiscalEnvironment;
  status: FiscalDocumentStatus;
  statusMessage: string | null;
  number: string | null;
  series: string | null;
  /** NF-e access key (44 digits). */
  accessKey: string | null;
  /** NFS-e verification code. */
  verificationCode: string | null;
  protocol: string | null;
  authorizedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  xmlUrl: string | null;
  pdfUrl: string | null;
  publicUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FiscalDocumentDetail extends FiscalDocument {
  requestPayload?: Record<string, unknown> | null;
  responsePayload?: Record<string, unknown> | null;
}

export interface FiscalSettings {
  entityId: string;
  provider: 'focus_nfe';
  environment: FiscalEnvironment;
  environments: FiscalEnvironment[];
  /** A company token is stored for the current environment (it is never returned). */
  hasCredentials: boolean;
  /** Environments that have a stored token. */
  credentialEnvironments: FiscalEnvironment[];
  credentialsReadable: boolean;
  nfseStandard: 'nacional' | 'municipal';
  /** Optional provider settings, when the server returns them. */
  dpsSeries?: string | null;
  simplesCreditRate?: number | null;
  codigoTributarioMunicipio?: string | null;
  webhook: {
    registered: boolean;
    events: string[];
    supportedEvents: string[];
    registeredAt: string | null;
  };
  providerUrl: string;
}

export interface UpdateFiscalSettingsInput {
  environment: FiscalEnvironment;
  /** The Focus NFe company token of `environment`; `null` removes the stored one, omitted keeps it. */
  token?: string | null;
  nfseStandard?: 'nacional' | 'municipal';
  dpsSeries?: string;
  /** CSOSN 101 credit percentage of a Simples Nacional issuer. */
  simplesCreditRate?: number;
  codigoTributarioMunicipio?: string;
}

export interface UpdateFiscalSettingsResult extends FiscalSettings {
  webhookUrl: string | null;
  /** Notes about what could not be set up (webhooks that were not registered, ...). */
  warnings: string[];
}

export interface FiscalDocumentQuery {
  sourceType?: string;
  sourceId?: string;
  status?: FiscalDocumentStatus;
  kind?: FiscalDocumentKind;
}

/** The carta de correção the provider registered. */
export interface FiscalCorrection {
  number?: number | string;
  [key: string]: unknown;
}

export type ReceivedStatus = 'new' | 'imported' | 'ignored';
export type ManifestationType = 'ciencia' | 'confirmacao' | 'desconhecimento' | 'nao_realizada';

/** An NF-e issued to the entity. */
export interface ReceivedFiscalDocument {
  id: string;
  entityId: string;
  kind: 'nfe' | 'nfse';
  accessKey: string;
  issuerTaxId: string | null;
  issuerName: string | null;
  number: string | null;
  series: string | null;
  issueDate: string | null;
  total: string | null;
  status: ReceivedStatus;
  /** The manifestação already sent, if any. */
  manifestation: ManifestationType | null;
  source: 'upload' | 'focus_nfe' | string;
  /** The parsed document (issuer, items, taxes, payments); only on the detail. */
  parsed?: Record<string, unknown> | null;
  /** The list leaves the XML out. */
  hasXml?: boolean;
  /** Issuer / totals digest of the parsed document (list view). */
  summary?: Record<string, unknown> | null;
  billId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SyncReceivedResult {
  fetched: number;
  created: number;
  updated: number;
  xmlFetched: number;
  /** There is more to fetch: call again. */
  hasMore: boolean;
  version?: number | string;
}

export interface CreateBillFromReceivedInput {
  contactId?: string;
  expenseAccountId?: string;
  /** YYYY-MM-DD. */
  dueDate?: string;
}

export interface CreateBillFromReceivedResult {
  bill: { id: string; billNumber?: string | null; [key: string]: unknown };
  document: ReceivedFiscalDocument;
  warnings: string[];
}

/** The details the fiscal routes attach to a refusal (`error.details`). */
export interface FiscalErrorDetails {
  /** Issue: what the invoice, the entity or the customer still lacks ("line 1: NCM (8 digits)"). */
  missing?: string[];
  /** The provider (Focus NFe) refused the document. */
  provider?: string;
  codigo?: string;
  erros?: Array<string | { mensagem?: string; message?: string; campo?: string }>;
  /** Issue twice: the document that already exists. */
  documentId?: string;
}

/** The `error.details` of a failed fiscal call, or an empty object. */
export function fiscalErrorDetails(err: unknown): FiscalErrorDetails {
  const body = err && typeof err === 'object' ? (err as { body?: unknown }).body : null;
  const details = body && typeof body === 'object' ? (body as { error?: { details?: unknown } }).error?.details : null;
  return details && typeof details === 'object' ? (details as FiscalErrorDetails) : {};
}

/** The provider's error lines as readable text. */
export function providerErrorLines(details: FiscalErrorDetails): string[] {
  return (details.erros ?? []).map((e) =>
    typeof e === 'string' ? e : [e.campo, e.mensagem ?? e.message].filter(Boolean).join(': '),
  );
}

interface ListResponse<T> {
  data: T[];
  pagination?: { totalCount: number; hasMore: boolean; cursor: string | null };
}

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

export const fiscalDocumentsApi = {
  settings: () => weldbooksApi.get<{ data: FiscalSettings }>('/fiscal-documents/settings'),
  updateSettings: (data: UpdateFiscalSettingsInput) =>
    weldbooksApi.put<{ data: UpdateFiscalSettingsResult }>('/fiscal-documents/settings', data),
  list: (params: FiscalDocumentQuery = {}) =>
    weldbooksApi.get<ListResponse<FiscalDocument>>(`/fiscal-documents${query({ ...params })}`),
  get: (id: string) => weldbooksApi.get<{ data: FiscalDocumentDetail }>(`/fiscal-documents/${id}`),
  issue: (invoiceId: string) => weldbooksApi.post<{ data: FiscalDocument }>('/fiscal-documents/issue', { invoiceId }),
  refresh: (id: string) => weldbooksApi.post<{ data: FiscalDocument }>(`/fiscal-documents/${id}/refresh`),
  cancel: (id: string, reason: string) =>
    weldbooksApi.post<{ data: FiscalDocument }>(`/fiscal-documents/${id}/cancel`, { reason }),
  correction: (id: string, text: string) =>
    weldbooksApi.post<{ data: { document: FiscalDocument; correction: FiscalCorrection } }>(
      `/fiscal-documents/${id}/correction`,
      { text },
    ),
};

export const receivedFiscalDocumentsApi = {
  list: (params: { status?: ReceivedStatus } = {}) =>
    weldbooksApi.get<ListResponse<ReceivedFiscalDocument>>(`/received-fiscal-documents${query({ ...params })}`),
  get: (id: string) => weldbooksApi.get<{ data: ReceivedFiscalDocument }>(`/received-fiscal-documents/${id}`),
  sync: () => weldbooksApi.post<{ data: SyncReceivedResult }>('/received-fiscal-documents/sync'),
  upload: (xml: string) =>
    weldbooksApi.post<{ data: ReceivedFiscalDocument }>('/received-fiscal-documents/upload', { xml }),
  manifest: (id: string, type: ManifestationType, reason?: string) =>
    weldbooksApi.post<{ data: ReceivedFiscalDocument }>(`/received-fiscal-documents/${id}/manifest`, {
      type,
      ...(reason ? { reason } : {}),
    }),
  createBill: (id: string, input: CreateBillFromReceivedInput = {}) =>
    weldbooksApi.post<{ data: CreateBillFromReceivedResult }>(`/received-fiscal-documents/${id}/create-bill`, input),
  ignore: (id: string) => weldbooksApi.post<{ data: ReceivedFiscalDocument }>(`/received-fiscal-documents/${id}/ignore`),
};
