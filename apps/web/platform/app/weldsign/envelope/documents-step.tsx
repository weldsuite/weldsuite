/** Step 1: the PDFs of the request, in signing order. */

import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, FileText, Loader2, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { SIGN_LIMITS, type SignDocumentDto, type SignEnvelopeDetail } from '@weldsuite/app-api-client/schemas/weldsign';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { useSignDocumentMutations } from '@/hooks/queries/use-weldsign-queries';
import { apiErrorMessage } from '../lib/errors';

const MAX_MB = SIGN_LIMITS.maxDocumentBytes / (1024 * 1024);

export function DocumentsStep({ envelope, editable }: Readonly<{ envelope: SignEnvelopeDetail; editable: boolean }>) {
  const { t, format } = useI18n();
  const td = t.weldsign.editor.documents;
  const { upload, reorder, remove } = useSignDocumentMutations(envelope.id);
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [removing, setRemoving] = useState<SignDocumentDto | null>(null);

  const documents = envelope.documents;
  const room = SIGN_LIMITS.maxDocuments - documents.length;

  async function addFiles(files: File[]) {
    for (const file of files.slice(0, Math.max(room, 0))) {
      const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
      if (!isPdf) {
        toast.error(format(td.notPdf, { name: file.name }));
        continue;
      }
      if (file.size > SIGN_LIMITS.maxDocumentBytes) {
        toast.error(format(td.tooLarge, { name: file.name, size: MAX_MB }));
        continue;
      }
      setUploading(file.name);
      try {
        await upload.mutateAsync(file);
      } catch (err) {
        toast.error(format(td.uploadFailed, { name: file.name, reason: apiErrorMessage(err) }));
      }
    }
    setUploading(null);
  }

  const move = (from: number, to: number) => {
    const ids = documents.map((d) => d.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved!);
    reorder.mutate(ids);
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-6">
      <div>
        <h2 className="text-lg font-semibold">{td.title}</h2>
        <p className="text-sm text-muted-foreground">{td.description}</p>
      </div>

      {editable && room > 0 && (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            void addFiles([...e.dataTransfer.files]);
          }}
          disabled={uploading !== null}
          className={cn(
            'flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center transition-colors',
            dragOver ? 'border-primary bg-primary/5' : 'hover:border-primary/60',
          )}
        >
          {uploading ? <Loader2 className="size-7 animate-spin text-primary" /> : <Upload className="size-7 text-muted-foreground" />}
          <span className="font-medium">{uploading ? format(td.uploading, { name: uploading }) : td.drop}</span>
          <span className="text-xs text-muted-foreground">{format(td.dropHint, { size: MAX_MB, count: SIGN_LIMITS.maxDocuments })}</span>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            hidden
            onChange={(e) => {
              void addFiles([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
        </button>
      )}

      {documents.length === 0 ? (
        !editable && <p className="text-sm text-muted-foreground">{td.empty}</p>
      ) : (
        <ol className="divide-y rounded-lg border">
          {documents.map((doc, i) => (
            <li key={doc.id} className="flex items-center gap-3 px-4 py-3">
              <FileText className="size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{doc.name}</p>
                <p className="text-xs text-muted-foreground">
                  {format(doc.pageCount === 1 ? td.pages : td.pagesPlural, { count: doc.pageCount })} ·{' '}
                  {(doc.sizeBytes / (1024 * 1024)).toFixed(1)} MB
                </p>
              </div>
              {editable && (
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" className="size-8" aria-label={td.moveUp} disabled={i === 0} onClick={() => move(i, i - 1)}>
                    <ArrowUp />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    aria-label={td.moveDown}
                    disabled={i === documents.length - 1}
                    onClick={() => move(i, i + 1)}
                  >
                    <ArrowDown />
                  </Button>
                  <Button variant="ghost" size="icon" className="size-8" aria-label={td.remove} onClick={() => setRemoving(doc)}>
                    <Trash2 />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={td.removeTitle}
        description={format(td.removeDescription, { name: removing?.name ?? '' })}
        confirmLabel={td.remove}
        variant="destructive"
        onConfirm={() => {
          if (removing) remove.mutate(removing.id);
          setRemoving(null);
        }}
      />
    </div>
  );
}
