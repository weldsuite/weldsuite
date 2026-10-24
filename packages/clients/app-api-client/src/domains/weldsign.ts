/**
 * App-API WeldSign domain client — `/api/sign/*` (sign-api).
 *
 * Drafts (envelopes, their PDFs, recipients and fields), sending, and a sent
 * request's lifecycle: void, remind, resend, correct an email, activity.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CorrectSignRecipientInput,
  CreateSignEnvelopeInput,
  CreateSignRecipientInput,
  ListSignEnvelopesQuery,
  ReorderSignDocumentsInput,
  ReplaceSignFieldsInput,
  SendSignEnvelopeInput,
  SignDocumentDto,
  SignEnvelopeDetail,
  SignEnvelopeSummary,
  SignEventDto,
  SignFieldDto,
  SignRecipientDto,
  SignRemindResult,
  SignSigningLink,
  UpdateSignEnvelopeInput,
  UpdateSignRecipientInput,
  VoidSignEnvelopeInput,
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

    /** Send a complete draft to its first signers. */
    send(id: string, input: SendSignEnvelopeInput = {}): Promise<DataResponse<SignEnvelopeDetail>> {
      return api.post(`${base}/${id}/send`, input);
    },
    /** The signed PDF with its certificate; the caller reads the response as a blob. */
    download(id: string): Promise<Response> {
      return api.getRaw(`${base}/${id}/download`);
    },

    /** Stop a sent request; its links stop working and signers who got it are told. */
    voidEnvelope(id: string, input: VoidSignEnvelopeInput): Promise<DataResponse<SignEnvelopeDetail>> {
      return api.post(`${base}/${id}/void`, input);
    },
    /** Remind every signer whose turn it is (not those reminded in the last hour). */
    remind(id: string): Promise<DataResponse<SignRemindResult>> {
      return api.post(`${base}/${id}/remind`, {});
    },
    /** Email a signer whose turn it is a new link. */
    resendRecipient(id: string, recipientId: string): Promise<DataResponse<SignRecipientDto>> {
      return api.post(`${base}/${id}/recipients/${recipientId}/resend`, {});
    },
    /** Fix a recipient's email on a sent request; their old link stops working. */
    correctRecipient(id: string, recipientId: string, input: CorrectSignRecipientInput): Promise<DataResponse<SignRecipientDto>> {
      return api.post(`${base}/${id}/recipients/${recipientId}/correct`, input);
    },
    /** The request's activity, oldest first (owners only). */
    events(id: string): Promise<DataResponse<SignEventDto[]>> {
      return api.get(`${base}/${id}/events`);
    },
    /** A fresh link for the caller's own turn to sign. */
    signingLink(id: string): Promise<DataResponse<SignSigningLink>> {
      return api.post(`${base}/${id}/signing-link`, {});
    },
  };
}

export type WeldSignApi = ReturnType<typeof createWeldSignApi>;
