/**
 * App-API WeldSign domain client — `/api/sign/*` (sign-api).
 *
 * Drafts in phase 1: envelopes, their PDFs, recipients and fields.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CreateSignEnvelopeInput,
  CreateSignRecipientInput,
  ListSignEnvelopesQuery,
  ReorderSignDocumentsInput,
  ReplaceSignFieldsInput,
  SignDocumentDto,
  SignEnvelopeDetail,
  SignEnvelopeSummary,
  SignFieldDto,
  SignRecipientDto,
  UpdateSignEnvelopeInput,
  UpdateSignRecipientInput,
} from '../schemas/weldsign';

const base = '/sign/envelopes';

export function createWeldSignApi(api: ClientApi) {
  return {
    list(params: ListSignEnvelopesQuery = {}): Promise<ListResponse<SignEnvelopeSummary>> {
      return api.get(`${base}${buildQueryString(params)}`);
    },
    get(id: string): Promise<DataResponse<SignEnvelopeDetail>> {
      return api.get(`${base}/${id}`);
    },
    create(input: CreateSignEnvelopeInput): Promise<DataResponse<SignEnvelopeDetail>> {
      return api.post(base, input);
    },
    update(id: string, input: UpdateSignEnvelopeInput): Promise<DataResponse<SignEnvelopeDetail>> {
      return api.patch(`${base}/${id}`, input);
    },
    /** Deletes a draft with its files. */
    remove(id: string): Promise<void> {
      return api.delete(`${base}/${id}`);
    },

    uploadDocument(id: string, file: File): Promise<DataResponse<SignDocumentDto>> {
      const form = new FormData();
      form.append('file', file);
      return api.postForm(`${base}/${id}/documents`, form);
    },
    /** The PDF bytes; the caller reads the response as an ArrayBuffer. */
    documentContent(id: string, documentId: string): Promise<Response> {
      return api.getRaw(`${base}/${id}/documents/${documentId}/content`);
    },
    reorderDocuments(id: string, input: ReorderSignDocumentsInput): Promise<DataResponse<SignDocumentDto[]>> {
      return api.put(`${base}/${id}/documents/order`, input);
    },
    removeDocument(id: string, documentId: string): Promise<void> {
      return api.delete(`${base}/${id}/documents/${documentId}`);
    },

    addRecipient(id: string, input: CreateSignRecipientInput): Promise<DataResponse<SignRecipientDto>> {
      return api.post(`${base}/${id}/recipients`, input);
    },
    updateRecipient(id: string, recipientId: string, input: UpdateSignRecipientInput): Promise<DataResponse<SignRecipientDto>> {
      return api.patch(`${base}/${id}/recipients/${recipientId}`, input);
    },
    removeRecipient(id: string, recipientId: string): Promise<void> {
      return api.delete(`${base}/${id}/recipients/${recipientId}`);
    },

    replaceFields(id: string, input: ReplaceSignFieldsInput): Promise<DataResponse<SignFieldDto[]>> {
      return api.put(`${base}/${id}/fields`, input);
    },
  };
}

export type WeldSignApi = ReturnType<typeof createWeldSignApi>;
