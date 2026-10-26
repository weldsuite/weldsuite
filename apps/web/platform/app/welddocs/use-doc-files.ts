/**
 * Files in the UI: storing an imported file's pictures, what an import says
 * when it is done or fails, downloads as .docx and PDF, and opening a
 * WeldDrive file (.docx, .md, .txt, .html) as a new document.
 */

import { useCallback } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@clerk/clerk-react';
import { useNavigate } from '@tanstack/react-router';
import { useCan } from '@weldsuite/permissions/react';
import type { CommentText, DocModel, DocxImportWarning } from '@weldsuite/docs-engine';
import { usePreviewMode } from '@/contexts/preview-mode-context';
import { useFileUpload } from '@/hooks/use-file-upload';
import { useIsAppInstalled } from '@/hooks/use-is-app-installed';
import { useI18n } from '@/lib/i18n/provider';
import { downloadDocument, type DownloadFormat } from './editor/download';
import { canImportName, fileBytes, imageFetcher, importFailure, type StoreImage } from './files';
import { useDocMutations } from './store/use-doc-store';

type I18n = ReturnType<typeof useI18n>;

/** Pictures a browser shows; others stay inside the document as they are. */
const WEB_IMAGES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Where an imported file's pictures go: WeldDrive storage in a workspace; the signed-out preview keeps them inside the document. */
export function useStoreImage(): StoreImage | undefined {
  const preview = usePreviewMode();
  const { uploadFile } = useFileUpload({ folder: 'welddocs', maxFileSize: MAX_IMAGE_BYTES, allowedTypes: WEB_IMAGES });
  const store = useCallback<StoreImage>(
    async (image) => {
      if (!WEB_IMAGES.includes(image.mime) || image.bytes.byteLength > MAX_IMAGE_BYTES) return null;
      const uploaded = await uploadFile(new File([image.bytes as BlobPart], image.name, { type: image.mime }));
      return uploaded?.url ?? null;
    },
    [uploadFile],
  );
  return preview ? undefined : store;
}

/** "Imported X", saying what the file had that the document does not. */
export function announceImport(name: string, warnings: DocxImportWarning[], { t, format }: Pick<I18n, 't' | 'format'>): void {
  const tf = t.welddocs.files;
  const list = warnings.map((w) => tf.warnings[w]).join(', ');
  if (list) toast.warning(format(tf.imported, { name }), { description: format(tf.leftOut, { list }) });
  else toast.success(format(tf.imported, { name }));
}

export function announceImportFailure(err: unknown, name: string, { t, format }: Pick<I18n, 't' | 'format'>): void {
  const tf = t.welddocs.files;
  const reasons = { too_large: tf.tooLarge, not_docx: tf.notDocx, corrupt: tf.corrupt, unsupported: tf.unsupported };
  const reason = importFailure(err);
  toast.error(format(t.welddocs.home.importFailed, { name }), reason ? { description: reasons[reason] } : undefined);
}

/**
 * Downloads a document; .docx and PDF are made in the browser with its
 * pictures. A .docx carries the comments `comments` reads (from the
 * document's chat); when they cannot be read it goes without them.
 */
export function useDocDownload(): (doc: DocModel, name: string, kind: DownloadFormat, comments?: (() => Promise<(thread: string) => CommentText[]>) | null) => Promise<void> {
  const { getToken } = useAuth();
  const { t, format, language } = useI18n();
  return useCallback(
    async (doc, name, kind, comments) => {
      const td = t.welddocs.download;
      const slow = kind === 'docx' || kind === 'pdf';
      const pending = slow ? toast.loading(format(td.preparing, { name })) : undefined;
      try {
        const said = kind === 'docx' && comments ? await comments().catch(() => undefined) : undefined;
        const file = await downloadDocument(doc, name, kind, { images: imageFetcher(() => getToken()), locale: language, comments: said });
        if (pending !== undefined) toast.dismiss(pending);
        if (file.missingImages) toast.warning(td.imagesLeftOut);
      } catch {
        if (pending !== undefined) toast.dismiss(pending);
        toast.error(format(td.failed, { name }));
      }
    },
    [format, getToken, language, t],
  );
}

/**
 * Makes a new document from a WeldDrive file and opens it (the file stays as
 * it is). Null where the workspace has no WeldDocs, the caller may not
 * create documents, or in the signed-out preview.
 */
export function useOpenInWeldDocs(): ((file: { name: string; url?: string | null }) => Promise<void>) | null {
  const installed = useIsAppInstalled('welddocs');
  const canCreate = useCan('docs:create');
  const { getToken } = useAuth();
  const navigate = useNavigate();
  const { importFile } = useDocMutations();
  const storeImage = useStoreImage();
  const i18n = useI18n();
  const preview = usePreviewMode();

  const open = useCallback(
    async (file: { name: string; url?: string | null }) => {
      const pending = toast.loading(i18n.format(i18n.t.welddocs.files.opening, { name: file.name }));
      try {
        const bytes = file.url ? await fileBytes(file.url, () => getToken()) : null;
        if (!bytes) throw new Error('The file could not be read');
        const { meta, warnings } = await importFile.mutateAsync({ fileName: file.name, bytes, storeImage });
        toast.dismiss(pending);
        announceImport(meta.name, warnings, i18n);
        await navigate({ to: '/welddocs/$docId', params: { docId: meta.id } });
      } catch (err) {
        toast.dismiss(pending);
        announceImportFailure(err, file.name, i18n);
      }
    },
    [getToken, i18n, importFile, navigate, storeImage],
  );
  return installed && canCreate && !preview ? open : null;
}

/** A WeldDrive file WeldDocs can open as a new document (a WeldDocs document itself opens as it is). */
export function canOpenInWeldDocs(file: { name: string; source?: string; isWeldDoc?: boolean }): boolean {
  return file.source === 'drive' && !file.isWeldDoc && canImportName(file.name);
}
