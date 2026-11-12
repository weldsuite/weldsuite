import { useCallback } from 'react';
import { toast } from 'sonner';
import { useNavigate } from '@tanstack/react-router';
import { useCan } from '@weldsuite/permissions/react';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { EmptyStateIllustration } from '@/components/entity-list';
import { NewFileStrip } from '@/components/office-home/new-file-strip';
import { OfficeFileList } from '@/components/office-home/office-file-list';
import { usePreviewMode } from '@/contexts/preview-mode-context';
import { useI18n } from '@/lib/i18n/provider';
import { IMPORT_ACCEPT, IMPORT_MAX_BYTES } from './files';
import { useDocList, useDocMutations, type DocMeta } from './store/use-doc-store';
import { announceImport, announceImportFailure, useStoreImage } from './use-doc-files';

const NO_DOCS: DocMeta[] = [];

/** WeldDocs home, laid out like WeldBoard's: a strip to start a document, then the standard list. */
export default function WeldDocsHome() {
  const { t } = useI18n();
  const th = t.welddocs.home;
  const preview = usePreviewMode();
  const docs = useDocList();
  const { create } = useDocMutations();
  const canCreate = useCan('docs:create');
  const actions = useDocActions();
  const open = useOpenDoc();
  const importFile = useDocImport(open);

  const createBlank = () => {
    if (create.isPending) return;
    // A failed create leaves nothing to open.
    void create.mutateAsync({ name: th.untitled }).then(open, () => undefined);
  };

  if (docs.isLoading) return <PageLoader fullScreen={false} />;

  return (
    <div className="flex w-full flex-col">
      {canCreate && (
        <NewFileStrip
          title={th.startNew}
          blankLabel={th.blank}
          importLabel={th.importFile}
          importHint={th.importHint}
          accept={IMPORT_ACCEPT}
          onBlank={createBlank}
          onImport={(file) => void importFile(file)}
        />
      )}
      {docs.isError && !docs.data ? (
        <ErrorState message={th.loadFailed} onRetry={() => void docs.refetch()} retryLabel={th.retry} className="py-16" />
      ) : (
        <OfficeFileList
          files={docs.data ?? NO_DOCS}
          labels={th}
          createLabel={th.newDoc}
          illustration={<DocsIllustration />}
          onOpen={open}
          {...actions}
          onCreate={canCreate ? createBlank : undefined}
          notice={preview ? <span className="text-xs text-muted-foreground">{th.localNotice}</span> : undefined}
          emptyStateClassName="min-h-[360px] py-12"
          deletePermanently={!!preview}
        />
      )}
    </div>
  );
}

/** The list's menu actions this member may use; a missing one hides its menu item. */
function useDocActions() {
  const { rename, remove } = useDocMutations();
  const canUpdate = useCan('docs:update');
  const canDelete = useCan('docs:delete');
  return {
    onRename: canUpdate ? (doc: DocMeta, name: string) => rename.mutate({ id: doc.id, name }) : undefined,
    onDelete: canDelete ? (doc: DocMeta) => remove.mutate(doc.id) : undefined,
  };
}

/** Opens a document in WeldDocs, or in the preview. */
function useOpenDoc() {
  const navigate = useNavigate();
  const preview = usePreviewMode();
  return useCallback(
    (doc: DocMeta) => {
      if (preview) void navigate({ to: '/preview/welddocs/$docId', params: { docId: doc.id } });
      else void navigate({ to: '/welddocs/$docId', params: { docId: doc.id } });
    },
    [navigate, preview],
  );
}

/** Imports a picked file as a new document and opens it. */
function useDocImport(open: (doc: DocMeta) => void) {
  const i18n = useI18n();
  const { t, format } = i18n;
  const th = t.welddocs.home;
  const storeImage = useStoreImage();
  const { importFile } = useDocMutations();

  return async (file: File | undefined) => {
    if (!file) return;
    if (file.size > IMPORT_MAX_BYTES) {
      toast.error(format(th.importFailed, { name: file.name }));
      return;
    }
    const pending = toast.loading(format(th.importing, { name: file.name }));
    try {
      const { meta, warnings } = await importFile.mutateAsync({ fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()), storeImage });
      toast.dismiss(pending);
      announceImport(meta.name, warnings, i18n);
      open(meta);
    } catch (err) {
      toast.dismiss(pending);
      announceImportFailure(err, file.name, i18n);
    }
  };
}

/** A page with lines of text, for the empty list. */
function DocsIllustration() {
  return (
    <EmptyStateIllustration>
      <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="26" y="12" width="68" height="96" rx="6" className="fill-white dark:fill-white/[0.03]" />
        <rect x="26" y="12" width="68" height="96" rx="6" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
        <line x1="38" y1="32" x2="70" y2="32" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="2" opacity="0.7" />
        <line x1="38" y1="46" x2="82" y2="46" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="1.5" opacity="0.5" />
        <line x1="38" y1="56" x2="82" y2="56" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="1.5" opacity="0.5" />
        <line x1="38" y1="66" x2="74" y2="66" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="1.5" opacity="0.5" />
        <line x1="38" y1="80" x2="82" y2="80" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="1.5" opacity="0.4" />
        <line x1="38" y1="90" x2="64" y2="90" className="stroke-gray-300 dark:stroke-white/20" strokeWidth="1.5" opacity="0.4" />
      </svg>
    </EmptyStateIllustration>
  );
}
