/**
 * Entity-attached documents (customer / person "Files" tab).
 *
 * STUBBED — this surface has no backend on any worker.
 *
 * These hooks used to call the legacy unified client's `files.*` methods, which
 * targeted `/api/files/*` on the obsolete api-worker. api-worker never mounted
 * `/api/files` (nor did core-api), so every call 404'd: the Files tab has never
 * worked in production, and no document has ever been stored through it.
 *
 * There is no app-api successor to repoint at:
 *  - `/api/files` is the *Drive* surface — folder-scoped, with no
 *    `entityType`/`entityId` filter, so "documents attached to this customer"
 *    cannot be queried;
 *  - `/api/storage/generate-upload-url` does broker an entity-scoped R2 key, but
 *    its `confirm-upload` partner returns a synthesised id **without inserting a
 *    row**, so uploads would not be listable afterwards;
 *  - there is no `/files/:id/url` presign route (`/files/:id/content` streams
 *    bytes instead).
 *
 * Why stub instead of delete: `components/objects/_shared/files-tab.tsx` still
 * renders this, so the exports must keep their signatures. Why stub instead of
 * leaving it on the legacy client: the legacy import is what keeps api-worker
 * alive, and these calls reach nothing either way.
 *
 * Behaviour of the stubs:
 *  - list hooks resolve to an empty page. This is ACCURATE, not a white lie —
 *    the upload path never worked, so there are no rows to list.
 *  - write hooks REJECT with a clear message. They must never resolve, or the
 *    tab would report a successful upload that stored nothing.
 *
 * TODO(weldflow-files): to restore the Files tab, build an entity-attached
 * document surface on app-api (list by entityType+entityId, presign upload,
 * confirm-upload that actually inserts, presign download) and repoint these six
 * hooks at it. A client-side repoint alone cannot fix this.
 */

import { useQuery, useMutation } from '@tanstack/react-query';

const customerDocumentKeys = {
  all: ['crm', 'customer-documents'] as const,
  forCustomer: (customerId: string) => [...customerDocumentKeys.all, customerId] as const,
  forPerson: (personId: string) => [...customerDocumentKeys.all, 'person', personId] as const,
};

/** Empty page, shaped like the list response `files-tab.tsx` destructures. */
const EMPTY_PAGE = { items: [] as unknown[] };

const UNAVAILABLE =
  'Attaching files to a customer or contact is not available yet — this feature has no backend.';

export function useCustomerDocuments(customerId: string, enabled = true) {
  return useQuery({
    queryKey: customerDocumentKeys.forCustomer(customerId),
    queryFn: async () => EMPTY_PAGE,
    enabled: !!customerId && enabled,
  });
}

/**
 * Person-scoped documents. Stored with entityType='Contact' to stay
 * compatible with files uploaded before the Companies/People refactor.
 */
export function usePersonDocuments(personId: string, enabled = true) {
  return useQuery({
    queryKey: customerDocumentKeys.forPerson(personId),
    queryFn: async () => EMPTY_PAGE,
    enabled: !!personId && enabled,
  });
}

export type DocumentEntityKind = 'Customer' | 'Contact';

export function useGenerateDocumentUploadUrl() {
  return useMutation({
    mutationFn: async (_params: {
      // `customerId` is kept as the param name for backwards-compat with the
      // existing customer-detail callers, but is reused for personId when
      // `entityKind='Contact'`.
      customerId: string;
      entityKind?: DocumentEntityKind;
      fileName: string;
      contentType: string;
      fileSize: number;
      description?: string;
      tags?: string;
    }): Promise<never> => {
      throw new Error(UNAVAILABLE);
    },
  });
}

export function useConfirmDocumentUpload() {
  return useMutation({
    mutationFn: async (_params: {
      uploadToken: string;
      fileKey: string;
      etag?: string;
      customerId: string;
      entityKind?: DocumentEntityKind;
    }): Promise<never> => {
      throw new Error(UNAVAILABLE);
    },
  });
}

export function useDocumentDownloadUrl() {
  return useMutation({
    mutationFn: async (_fileId: string): Promise<never> => {
      throw new Error(UNAVAILABLE);
    },
  });
}

export function useDeleteCustomerDocument() {
  return useMutation({
    mutationFn: async (_params: {
      fileId: string;
      customerId: string;
      entityKind?: DocumentEntityKind;
    }): Promise<never> => {
      throw new Error(UNAVAILABLE);
    },
  });
}
