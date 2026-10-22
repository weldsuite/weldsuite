/**
 * Entity-attached documents (customer / person "Files" tab).
 *
 * Backed by the same `files` table / `/api/files` + `/api/storage` endpoints
 * as WeldDrive (`hooks/queries/use-drive-queries.ts`), scoped via the
 * `files.entityType` + `files.entityId` columns:
 *  - List: `GET /api/files?entityType=company|person&entityId=<id>`.
 *  - Upload: the existing 3-step broker (`POST /storage/generate-upload-url`
 *    → `PUT` to the presigned URL → `POST /files` to persist the row), same
 *    flow as `hooks/use-file-upload.ts` + `useCreateDriveFile`, just inlined
 *    here so the upload mutation can carry entityType/entityId end to end.
 *  - Download: `GET /api/files/:id/content` via the `downloadFile` helper
 *    exported from `app/welddrive/components/drive-file-card.tsx` (reused
 *    directly by `files-tab.tsx`, same as `FileListView` already does for
 *    its icon/formatting helpers).
 *
 * `files.entityType`/`entityId` were already present on the schema (used by
 * nothing else yet) — no DB migration was needed for this.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import type { UnifiedFile } from '@/lib/api/domains/welddrive';

const customerDocumentKeys = {
  all: ['crm', 'customer-documents'] as const,
  forCustomer: (customerId: string) => [...customerDocumentKeys.all, customerId] as const,
  forPerson: (personId: string) => [...customerDocumentKeys.all, 'person', personId] as const,
};

export type DocumentEntityKind = 'Customer' | 'Contact';

/** Maps the Files-tab's `Customer`/`Contact` kind to the `files.entityType` value. */
function toFilesEntityType(entityKind: DocumentEntityKind | undefined): 'company' | 'person' {
  return entityKind === 'Contact' ? 'person' : 'company';
}

export function useCustomerDocuments(customerId: string, enabled = true) {
  const { files } = useAppApi();
  return useQuery({
    queryKey: customerDocumentKeys.forCustomer(customerId),
    queryFn: async (): Promise<{ items: UnifiedFile[] }> => {
      const res = await files.list({ entityType: 'company', entityId: customerId });
      return { items: res.data ?? [] };
    },
    enabled: !!customerId && enabled,
  });
}

/**
 * Person-scoped documents. Stored with entityType='person' (the Companies/People
 * model — see `files.entityType`).
 */
export function usePersonDocuments(personId: string, enabled = true) {
  const { files } = useAppApi();
  return useQuery({
    queryKey: customerDocumentKeys.forPerson(personId),
    queryFn: async (): Promise<{ items: UnifiedFile[] }> => {
      const res = await files.list({ entityType: 'person', entityId: personId });
      return { items: res.data ?? [] };
    },
    enabled: !!personId && enabled,
  });
}

export function useGenerateDocumentUploadUrl() {
  const { storage } = useAppApi();
  return useMutation({
    mutationFn: (params: {
      // `customerId` is kept as the param name for backwards-compat with the
      // existing customer-detail callers, but is reused for personId when
      // `entityKind='Contact'`.
      customerId: string;
      entityKind?: DocumentEntityKind;
      fileName: string;
      contentType: string;
      fileSize: number;
    }) =>
      storage.generateUploadUrl({
        fileName: params.fileName,
        contentType: params.contentType,
        fileSize: params.fileSize,
        folder: 'documents',
        entityType: toFilesEntityType(params.entityKind),
        entityId: params.customerId,
        isPublic: false,
      }),
  });
}

/**
 * Persists the `files` row after the browser has PUT the bytes to the
 * presigned URL (`useGenerateDocumentUploadUrl`). Unlike the generic
 * `/storage/confirm-upload` (which only validates the R2 object landed and
 * returns an ephemeral, non-persisted id), this calls `POST /api/files` so
 * the upload is actually listable afterwards.
 */
export function useConfirmDocumentUpload() {
  const { files } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      fileKey: string;
      fileName: string;
      contentType: string;
      fileSize: number;
      customerId: string;
      entityKind?: DocumentEntityKind;
    }) =>
      files.create({
        fileName: params.fileName,
        mimeType: params.contentType,
        fileSize: params.fileSize,
        fileType: 'file',
        storagePath: params.fileKey,
        fileKey: params.fileKey,
        entityType: toFilesEntityType(params.entityKind),
        entityId: params.customerId,
      }),
    onSuccess: (_data, variables) => {
      const key =
        variables.entityKind === 'Contact'
          ? customerDocumentKeys.forPerson(variables.customerId)
          : customerDocumentKeys.forCustomer(variables.customerId);
      qc.invalidateQueries({ queryKey: key });
    },
  });
}

export function useDeleteCustomerDocument() {
  const { files } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { fileId: string; customerId: string; entityKind?: DocumentEntityKind }) =>
      files.delete(params.fileId),
    onSuccess: (_data, variables) => {
      const key =
        variables.entityKind === 'Contact'
          ? customerDocumentKeys.forPerson(variables.customerId)
          : customerDocumentKeys.forCustomer(variables.customerId);
      qc.invalidateQueries({ queryKey: key });
    },
  });
}
