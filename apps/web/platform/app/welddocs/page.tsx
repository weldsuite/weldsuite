import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { useNavigate } from '@tanstack/react-router';
import { useCan } from '@weldsuite/permissions/react';
import { FileText, MoreHorizontal, Plus, Upload } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageLoader } from '@/components/page-loader';
import { usePreviewMode } from '@/contexts/preview-mode-context';
import { useI18n } from '@/lib/i18n/provider';
import { IMPORT_ACCEPT, IMPORT_MAX_BYTES } from './files';
import { useDocList, useDocMutations, type DocMeta } from './store/use-doc-store';
import { announceImport, announceImportFailure, useStoreImage } from './use-doc-files';

export default function WeldDocsHome() {
  const i18n = useI18n();
  const { t, format, language } = i18n;
  const storeImage = useStoreImage();
  const th = t.welddocs.home;
  const navigate = useNavigate();
  const preview = usePreviewMode();
  const { data: docs, isLoading } = useDocList();
  const { create, rename, remove, importFile } = useDocMutations();
  const [deleting, setDeleting] = useState<DocMeta | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const canCreate = useCan('docs:create');
  const canUpdate = useCan('docs:update');
  const canDelete = useCan('docs:delete');

  const open = (docId: string) => {
    if (preview) navigate({ to: '/preview/welddocs/$docId', params: { docId } }).catch(() => undefined);
    else navigate({ to: '/welddocs/$docId', params: { docId } }).catch(() => undefined);
  };

  const createDoc = async () => {
    const meta = await create.mutateAsync({ name: th.untitled });
    open(meta.id);
  };

  const importPicked = async (file: File | undefined) => {
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
      open(meta.id);
    } catch (err) {
      toast.dismiss(pending);
      announceImportFailure(err, file.name, i18n);
    }
  };

  const promptRename = (doc: DocMeta) => {
    const name = window.prompt(th.rename, doc.name)?.trim();
    if (name && name !== doc.name) rename.mutate({ id: doc.id, name });
  };

  const edited = (ms: number) =>
    format(th.edited, { time: new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms)) });

  if (isLoading) return <PageLoader fullScreen={false} />;

  return (
    <div className="flex w-full flex-col">
      {canCreate && (
        <section className="border-b bg-muted/40">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-6 py-6">
            <h2 className="text-sm font-medium text-muted-foreground">{th.startNew}</h2>
            <div className="flex gap-4">
              <button type="button" onClick={() => void createDoc()} disabled={create.isPending} className="group flex w-36 flex-col items-stretch gap-2 text-left">
                <span className="flex aspect-[1/1.3] items-center justify-center rounded-md border bg-background transition group-hover:border-primary">
                  <Plus className="size-10 text-primary" />
                </span>
                <span className="text-sm font-medium">{th.blank}</span>
              </button>
              <button type="button" onClick={() => fileInput.current?.click()} disabled={importFile.isPending} className="group flex w-36 flex-col items-stretch gap-2 text-left">
                <span className="flex aspect-[1/1.3] flex-col items-center justify-center gap-1 rounded-md border border-dashed bg-background transition group-hover:border-primary">
                  <Upload className="size-8 text-muted-foreground group-hover:text-primary" />
                  <span className="text-xs text-muted-foreground">{th.importHint}</span>
                </span>
                <span className="text-sm font-medium">{th.importFile}</span>
              </button>
              <input
                ref={fileInput}
                type="file"
                accept={IMPORT_ACCEPT}
                className="hidden"
                onChange={(e) => {
                  void importPicked(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </div>
          </div>
        </section>
      )}

      <section className="mx-auto flex w-full max-w-5xl flex-col gap-3 p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground">{th.recent}</h2>
          {canCreate && (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()} disabled={importFile.isPending}>
                <Upload />
                {th.import}
              </Button>
              <Button size="sm" onClick={() => void createDoc()} disabled={create.isPending}>
                <Plus />
                {th.newDoc}
              </Button>
            </div>
          )}
        </div>
        {preview && <p className="text-xs text-muted-foreground">{th.localNotice}</p>}

        {!docs?.length ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
            <FileText className="size-8 text-muted-foreground" />
            <p className="font-medium">{th.emptyTitle}</p>
            <p className="max-w-sm text-sm text-muted-foreground">{th.emptyDescription}</p>
          </div>
        ) : (
          <ul className="divide-y rounded-lg border">
            {docs.map((doc) => (
              <li key={doc.id} className="flex items-center gap-3 px-4 py-2 hover:bg-muted/50">
                <FileText className="size-5 shrink-0 text-blue-600" />
                <button type="button" className="min-w-0 flex-1 truncate text-left text-sm font-medium" onClick={() => open(doc.id)}>
                  {doc.name}
                </button>
                <span className="shrink-0 text-xs text-muted-foreground">{edited(doc.updatedAt)}</span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="size-8" aria-label={doc.name}>
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => open(doc.id)}>{th.open}</DropdownMenuItem>
                    {canUpdate && doc.canEdit && <DropdownMenuItem onSelect={() => promptRename(doc)}>{th.rename}</DropdownMenuItem>}
                    {canDelete && doc.canEdit && (
                      <DropdownMenuItem className="text-destructive" onSelect={() => setDeleting(doc)}>
                        {th.delete}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={th.deleteTitle}
        description={format(preview ? th.deletePermanently : th.deleteDescription, { name: deleting?.name ?? '' })}
        confirmLabel={th.delete}
        variant="destructive"
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
          setDeleting(null);
        }}
      />
    </div>
  );
}
