/**
 * `FilesTab` — Files tab for the company / person object panels.
 *
 * Lists files attached to this entity via the unified Files API. Company
 * side uses `entityType='Customer'`; person side uses `entityType='Contact'`.
 * Supports upload via the presigned-URL flow and per-row download + delete.
 *
 * Renders through `FileListView` so the list matches the WeldDrive design 1:1.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Download,
  File as FileIcon,
  Trash2,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  FileListView,
  fileCategoryFromContentType,
  type FileListItem,
} from '@/components/files/file-list-view';
import {
  useCustomerDocuments,
  usePersonDocuments,
  useGenerateDocumentUploadUrl,
  useConfirmDocumentUpload,
  useDocumentDownloadUrl,
  useDeleteCustomerDocument,
} from '@/hooks/queries/use-customer-documents-queries';
import type { FileResponse } from '@/lib/api/legacy-types';

interface FilesTabProps {
  entityId: string;
  entityKind: 'company' | 'person';
}

export function FilesTab({ entityId, entityKind }: FilesTabProps) {
  const t = useTranslations();
  const entityKindForApi = entityKind === 'company' ? ('Customer' as const) : ('Contact' as const);
  const companyQuery = useCustomerDocuments(entityId, entityKind === 'company');
  const personQuery = usePersonDocuments(entityId, entityKind === 'person');
  const { data, isLoading } = entityKind === 'company' ? companyQuery : personQuery;
  const generateUrl = useGenerateDocumentUploadUrl();
  const confirmUpload = useConfirmDocumentUpload();
  const getDownloadUrl = useDocumentDownloadUrl();
  const deleteFile = useDeleteCustomerDocument();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);

  const listItems = useMemo<FileListItem[]>(() => {
    const files = (data?.items ?? []) as FileResponse[];
    return files.map((f) => ({
      id: f.id,
      name: f.fileName,
      fileType: fileCategoryFromContentType(f.contentType),
      fileSize: f.size,
      createdAt: f.createdAt,
    }));
  }, [data]);

  const handleUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      e.target.value = ''; // allow re-selecting same file
      setIsUploading(true);
      try {
        const presigned = (await generateUrl.mutateAsync({
          customerId: entityId,
          entityKind: entityKindForApi,
          fileName: file.name,
          contentType: file.type || 'application/octet-stream',
          fileSize: file.size,
        })) as { uploadUrl: string; uploadToken: string; fileKey: string };
        // Direct PUT to R2.
        const putRes = await fetch(presigned.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        });
        if (!putRes.ok) throw new Error(`Upload failed: ${putRes.status}`);
        await confirmUpload.mutateAsync({
          uploadToken: presigned.uploadToken,
          fileKey: presigned.fileKey,
          etag: putRes.headers.get('etag') ?? undefined,
          customerId: entityId,
          entityKind: entityKindForApi,
        });
        toast.success(t('sweep.entities.uploadedFile', { fileName: file.name }));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('sweep.entities.uploadFailed'));
      } finally {
        setIsUploading(false);
      }
    },
    [entityId, entityKindForApi, generateUrl, confirmUpload, t],
  );

  const handleDownload = useCallback(
    async (fileId: string) => {
      try {
        const { url } = await getDownloadUrl.mutateAsync(fileId);
        window.open(url, '_blank', 'noopener,noreferrer');
      } catch {
        toast.error(t('sweep.entities.downloadUrlFailed'));
      }
    },
    [getDownloadUrl, t],
  );

  const handleDelete = useCallback(
    async (fileId: string, fileName: string) => {
      try {
        await deleteFile.mutateAsync({
          fileId,
          customerId: entityId,
          entityKind: entityKindForApi,
        });
        toast.success(t('sweep.entities.deletedFile', { fileName }));
      } catch {
        toast.error(t('sweep.entities.deleteFailed'));
      }
    },
    [entityId, entityKindForApi, deleteFile, t],
  );

  const renderRowMenu = useCallback(
    (item: FileListItem) => (
      <>
        <DropdownMenuItem onClick={() => handleDownload(item.id)}>
          <Download className="h-4 w-4 mr-0.5" />
          {t('sweep.entities.download')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-red-600 focus:text-red-600 focus:bg-red-50 dark:focus:bg-red-950"
          onClick={() => handleDelete(item.id, item.name)}
        >
          <Trash2 className="h-4 w-4 mr-0.5 text-red-600" />
          {t('sweep.entities.delete')}
        </DropdownMenuItem>
      </>
    ),
    [handleDownload, handleDelete, t],
  );

  return (
    <>
      <input ref={fileInputRef} type="file" className="hidden" onChange={handleUpload} />
      <FileListView
        items={listItems}
        isLoading={isLoading}
        searchPlaceholder={t('sweep.entities.searchFilesPlaceholder')}
        onRowClick={(item) => handleDownload(item.id)}
        renderRowMenu={renderRowMenu}
        actionButtons={
          <Button
            size="sm"
            className="h-8 gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
          >
            <Upload className="h-3.5 w-3.5" />
            {isUploading ? t('sweep.entities.uploading') : t('sweep.entities.upload')}
          </Button>
        }
        emptyState={{
          icon: (
            <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center mb-3">
              <FileIcon className="h-5 w-5 text-muted-foreground" />
            </div>
          ),
          title: t('sweep.entities.noFilesYetTitle'),
          description:
            entityKind === 'company'
              ? t('sweep.entities.noFilesYetDescriptionCompany')
              : t('sweep.entities.noFilesYetDescriptionPerson'),
        }}
        noResultsState={{
          title: t('sweep.entities.noFilesFoundTitle'),
          description: t('sweep.entities.noFilesFoundDescription'),
        }}
      />
    </>
  );
}
