/**
 * `FilesTab` — Files tab for the company / person object panels.
 *
 * Lists files attached to this entity via the same `/api/files` store as
 * WeldDrive, scoped by `files.entityType`/`entityId` (company/person — see
 * `hooks/queries/use-customer-documents-queries.ts`). The `Customer`/`Contact`
 * kind below is this component's own prop naming and gets mapped to
 * `company`/`person` inside those hooks. Supports upload via the
 * presigned-URL flow and per-row download + delete.
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
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  FileListView,
  fileCategoryFromContentType,
  type FileListItem,
} from '@/components/files/file-list-view';
import { downloadFile } from '@/app/welddrive/components/drive-file-card';
import {
  useCustomerDocuments,
  usePersonDocuments,
  useGenerateDocumentUploadUrl,
  useConfirmDocumentUpload,
  useDeleteCustomerDocument,
} from '@/hooks/queries/use-customer-documents-queries';
import type { UnifiedFile } from '@/lib/api/domains/welddrive';

interface FilesTabProps {
  entityId: string;
  entityKind: 'company' | 'person';
}

export function FilesTab({ entityId, entityKind }: Readonly<FilesTabProps>) {
  const t = useTranslations();
  const entityKindForApi = entityKind === 'company' ? ('Customer' as const) : ('Contact' as const);
  const companyQuery = useCustomerDocuments(entityId, entityKind === 'company');
  const personQuery = usePersonDocuments(entityId, entityKind === 'person');
  const { data, isLoading } = entityKind === 'company' ? companyQuery : personQuery;
  const generateUrl = useGenerateDocumentUploadUrl();
  const confirmUpload = useConfirmDocumentUpload();
  const deleteFile = useDeleteCustomerDocument();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  // Row ⋮ > Delete only stages the file here; the request fires from the confirm dialog.
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);

  // Keep the raw rows around (keyed by id) so download — which needs the
  // `files` row's url/source, not just what the list row displays — doesn't
  // need a second fetch.
  const filesById = useMemo(() => {
    const map = new Map<string, UnifiedFile>();
    for (const f of data?.items ?? []) map.set(f.id, f);
    return map;
  }, [data]);

  const listItems = useMemo<FileListItem[]>(() => {
    const files = data?.items ?? [];
    return files.map((f) => ({
      id: f.id,
      name: f.name,
      fileType: fileCategoryFromContentType(f.mimeType ?? ''),
      source: f.source,
      fileSize: f.fileSize,
      createdAt: f.createdAt,
      isStarred: f.isStarred,
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
          fileKey: presigned.fileKey,
          fileName: file.name,
          contentType: file.type || 'application/octet-stream',
          fileSize: file.size,
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

  // `downloadFile` handles its own errors (toasts + console.error) and never
  // rejects, so this is a thin pass-through — no local try/catch needed.
  const handleDownload = useCallback(
    (item: FileListItem) => {
      const row = filesById.get(item.id);
      return downloadFile({
        id: item.id,
        name: item.name,
        url: row?.url ?? null,
        source: row?.source ?? 'drive',
      });
    },
    [filesById],
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
        <DropdownMenuItem onClick={() => handleDownload(item)}>
          <Download />
          {t('sweep.entities.download')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() => setPendingDelete({ id: item.id, name: item.name })}
        >
          <Trash2 />
          {t('sweep.entities.delete')}
        </DropdownMenuItem>
      </>
    ),
    [handleDownload, t],
  );

  return (
    <>
      <input ref={fileInputRef} type="file" className="hidden" onChange={handleUpload} />
      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={t('sweep.entities.deleteFileTitle')}
        description={t('sweep.entities.deleteFileDescription', { fileName: pendingDelete?.name ?? '' })}
        variant="destructive"
        confirmLabel={t('sweep.entities.delete')}
        cancelLabel={t('sweep.entities.cancel')}
        loading={deleteFile.isPending}
        onConfirm={async () => {
          if (!pendingDelete) return;
          await handleDelete(pendingDelete.id, pendingDelete.name);
          setPendingDelete(null);
        }}
      />
      <FileListView
        items={listItems}
        isLoading={isLoading}
        searchPlaceholder={t('sweep.entities.searchFilesPlaceholder')}
        onRowClick={(item) => handleDownload(item)}
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
