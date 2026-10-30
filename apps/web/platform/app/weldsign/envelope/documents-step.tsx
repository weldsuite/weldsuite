/**
 * The PDFs of a request or template, in signing order. A PDF comes from the
 * member's computer (the upload button, or dropped on the page) or from
 * WeldDrive, where it is copied in.
 *
 * `useDocuments` holds what adding, moving and removing needs; the pieces below
 * show it. A template's step (`DocumentsStep`) lists the PDFs as the platform's
 * lists are; a request lists them in its side panel (`DocumentList`) and shows
 * the empty state in its preview.
 */

import { useRef, useState, type DragEvent } from 'react';
import { FileText, Loader2, Monitor, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { SIGN_LIMITS, type SignDocumentDto, type SignEnvelopeDetail } from '@weldsuite/app-api-client/schemas/weldsign';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyStateIllustration, EntityList, type HeaderColumn } from '@/components/entity-list';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { PANEL_ROW } from './editor-frame';
import { DriveFilePickerDialog } from '@/app/welddrive/components/drive-file-picker-dialog';
import type { UnifiedFile } from '@/lib/api/domains/welddrive';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { targetOf, useSignDocumentMutations } from '@/hooks/queries/use-weldsign-queries';
import { apiErrorMessage } from '../lib/errors';
import { isSignablePdf } from '../lib/source';

const MAX_MB = SIGN_LIMITS.maxDocumentBytes / (1024 * 1024);
const PDF_ACCEPT = 'application/pdf,.pdf';

export type DocumentsState = ReturnType<typeof useDocuments>;

/** Adding, moving and removing the PDFs of a request or template. Render `DocumentDialogs` once with it. */
export function useDocuments(envelope: SignEnvelopeDetail, editable: boolean) {
  const { t, format } = useI18n();
  const td = t.weldsign.editor.documents;
  const { upload, reorder, remove, addFromDrive } = useSignDocumentMutations(targetOf(envelope));
  // Reading WeldDrive takes `files:read`; the server checks it again.
  const canReadDrive = useCan('files:read');
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [picking, setPicking] = useState(false);
  const [removing, setRemoving] = useState<SignDocumentDto | null>(null);

  const documents = envelope.documents;
  const room = SIGN_LIMITS.maxDocuments - documents.length;
  const canAdd = editable && room > 0;

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

  /** Copies the chosen WeldDrive PDFs in, one after another. The server checks each one like an upload. */
  async function addDriveFiles(files: UnifiedFile[]) {
    for (const file of files.slice(0, Math.max(room, 0))) {
      try {
        await addFromDrive.mutateAsync(file.id);
      } catch (err) {
        toast.error(format(td.uploadFailed, { name: file.name, reason: apiErrorMessage(err) }));
      }
    }
  }

  // Files dropped where these go are added; `dragOver` says to show where they land.
  const dropHandlers = canAdd
    ? {
        onDragOver: (e: DragEvent) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setDragOver(true);
        },
        onDragLeave: (e: DragEvent) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
        },
        onDrop: (e: DragEvent) => {
          e.preventDefault();
          setDragOver(false);
          void addFiles([...e.dataTransfer.files]);
        },
      }
    : {};

  return {
    documents,
    room,
    canAdd,
    canReadDrive,
    editable,
    busy: uploading !== null,
    dragOver,
    dropHandlers,
    inputRef,
    picking,
    removing,
    addFiles,
    addDriveFiles,
    openUpload: () => inputRef.current?.click(),
    openDrive: () => setPicking(true),
    closeDrive: () => setPicking(false),
    askRemove: setRemoving,
    confirmRemove: () => {
      if (removing) remove.mutate(removing.id);
      setRemoving(null);
    },
    move: (from: number, to: number) => {
      const ids = documents.map((d) => d.id);
      const [moved] = ids.splice(from, 1);
      ids.splice(to, 0, moved!);
      reorder.mutate(ids);
    },
  };
}

/** The file input, the WeldDrive picker and the remove confirmation. */
export function DocumentDialogs({ docs }: Readonly<{ docs: DocumentsState }>) {
  const { t, format } = useI18n();
  const td = t.weldsign.editor.documents;
  return (
    <>
      {docs.canAdd && (
        <input
          ref={docs.inputRef}
          type="file"
          accept={PDF_ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            void docs.addFiles([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
      )}

      {docs.picking && (
        <DriveFilePickerDialog
          title={td.drive.title}
          description={td.drive.description}
          confirmLabel={td.drive.confirm}
          pendingLabel={td.drive.adding}
          fileType="pdf"
          accept={isSignablePdf}
          maxSelect={docs.room}
          upload={{ accept: PDF_ACCEPT, onFiles: (files) => void docs.addFiles(files) }}
          onConfirm={docs.addDriveFiles}
          onClose={docs.closeDrive}
        />
      )}

      <ConfirmDialog
        open={docs.removing !== null}
        onOpenChange={(open) => !open && docs.askRemove(null)}
        title={td.removeTitle}
        description={format(td.removeDescription, { name: docs.removing?.name ?? '' })}
        confirmLabel={td.remove}
        variant="destructive"
        onConfirm={docs.confirmRemove}
      />
    </>
  );
}

/** Upload, the main action, and "Add from WeldDrive". */
export function AddDocumentButtons({ docs }: Readonly<{ docs: DocumentsState }>) {
  const { t } = useI18n();
  const td = t.weldsign.editor.documents;
  return (
    <>
      <Button size="sm" className="h-8" disabled={docs.busy} onClick={docs.openUpload}>
        {docs.busy ? <Loader2 className="animate-spin" /> : <Plus />}
        {td.upload}
      </Button>
      {docs.canReadDrive && (
        <Button size="sm" variant="outline" className="h-8" disabled={docs.busy} onClick={docs.openDrive}>
          {td.fromDrive}
        </Button>
      )}
    </>
  );
}

/** One "Add PDFs" button whose menu asks where from: the computer or WeldDrive. Without `files:read` it uploads straight away. */
export function AddDocumentMenu({ docs }: Readonly<{ docs: DocumentsState }>) {
  const { t } = useI18n();
  const td = t.weldsign.editor.documents;
  const icon = docs.busy ? <Loader2 className="animate-spin" /> : <Plus />;
  if (!docs.canReadDrive) {
    return (
      <Button size="sm" variant="outline" className="h-8" disabled={docs.busy} onClick={docs.openUpload}>
        {icon}
        {td.upload}
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className="h-8" disabled={docs.busy}>
          {icon}
          {td.add}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={docs.openUpload}>
          <Monitor />
          {td.source.computer}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={docs.openDrive}>
          <WeldDriveIcon />
          {td.source.drive}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The WeldDrive logo (`/assets/images/welddrive/icon.svg`) in the current colour, so a menu item tints it as it does its other icons. */
function WeldDriveIcon() {
  return (
    <svg viewBox="0 0 708.41 611.43" fill="currentColor" aria-hidden="true">
      <path d="M708.41,198.1v312.25c0,55.83-45.26,101.08-101.08,101.08H101.08c-55.83,0-101.08-45.26-101.08-101.08V101.08C0,45.26,45.26,0,101.08,0h123.91c31.97,0,62.06,15.12,81.13,40.78l34.05,45.81c4.87,6.55,12.56,10.42,20.72,10.42h246.42c55.83,0,101.08,45.26,101.08,101.08Z" />
    </svg>
  );
}

/** The illustrated empty state of the platform's lists, with the add buttons. */
export function DocumentsEmptyState({ docs }: Readonly<{ docs: DocumentsState }>) {
  const { t, format } = useI18n();
  const td = t.weldsign.editor.documents;
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <EmptyStateIllustration width={260} height={170}>
        <PdfDrawing />
      </EmptyStateIllustration>
      <h3 className="mb-1.5 text-[15px] font-semibold text-foreground">{td.emptyTitle}</h3>
      {docs.canAdd && (
        <>
          <p className="mb-5 max-w-[320px] text-sm leading-relaxed text-muted-foreground">
            {format(td.dropHint, { size: MAX_MB, count: SIGN_LIMITS.maxDocuments })}
          </p>
          <div className="flex items-center gap-2">
            <AddDocumentButtons docs={docs} />
          </div>
        </>
      )}
    </div>
  );
}

/** The dashed outline over the place files are dropped on. Its parent is positioned. */
export function DropOverlay() {
  const { t } = useI18n();
  return (
    <div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-primary/5 text-sm font-medium text-primary">
      {t.weldsign.editor.documents.dropOverlay}
    </div>
  );
}

/** A document's menu items: move it up or down the signing order, or remove it. */
function DocumentMenuItems({ docs, index }: Readonly<{ docs: DocumentsState; index: number }>) {
  const { t } = useI18n();
  const td = t.weldsign.editor.documents;
  return (
    <>
      <DropdownMenuItem disabled={index === 0} onSelect={() => docs.move(index, index - 1)}>
        {td.moveUp}
      </DropdownMenuItem>
      <DropdownMenuItem disabled={index === docs.documents.length - 1} onSelect={() => docs.move(index, index + 1)}>
        {td.moveDown}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem className="text-destructive" onSelect={() => docs.askRemove(docs.documents[index]!)}>
        {td.remove}
      </DropdownMenuItem>
    </>
  );
}

/** The list's columns: the name, with the signing order, then pages and size. */
const COLUMN = {
  name: 'min-w-0 flex-1',
  pages: 'w-[100px] @max-[560px]:w-[80px]',
  size: 'w-[100px] @max-[560px]:w-[70px]',
};

function documentColumns(td: ReturnType<typeof useI18n>['t']['weldsign']['editor']['documents']): HeaderColumn[] {
  return [
    { id: 'name', header: td.columnName, width: COLUMN.name },
    { id: 'pages', header: td.columnPages, width: COLUMN.pages },
    { id: 'size', header: td.columnSize, width: COLUMN.size },
  ];
}

/** A standard list row for a document; `onOpen` makes the whole row clickable. */
function DocumentRow({ docs, doc, onOpen, className }: Readonly<{ docs: DocumentsState; doc: SignDocumentDto; onOpen?: () => void; className?: string }>) {
  const { t, format } = useI18n();
  const td = t.weldsign.editor.documents;
  const i = docs.documents.indexOf(doc);
  return (
    <TabListRow
      label={doc.name}
      onOpen={onOpen}
      menuLabel={doc.name}
      menu={docs.editable ? <DocumentMenuItems docs={docs} index={i} /> : undefined}
      className={className}
    >
      <div className={cn(COLUMN.name, 'flex items-center gap-2')}>
        <span className="w-3 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{i + 1}</span>
        <FileText className="size-4 shrink-0 text-red-500" />
        <span className="truncate text-sm font-medium text-foreground">{doc.name}</span>
      </div>
      <div className={cn(COLUMN.pages, 'min-w-0 truncate text-sm tabular-nums text-muted-foreground')}>
        {format(doc.pageCount === 1 ? td.pages : td.pagesPlural, { count: doc.pageCount })}
      </div>
      <div className={cn(COLUMN.size, 'min-w-0 truncate text-sm tabular-nums text-muted-foreground')}>{sizeOf(doc)}</div>
    </TabListRow>
  );
}

const sizeOf = (doc: SignDocumentDto) => `${(doc.sizeBytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * The documents in a side panel: the standard list, in signing order, a click
 * opening the document (`onOpen`), and the add button under it.
 */
export function DocumentList({ docs, onOpen }: Readonly<{ docs: DocumentsState; onOpen: (doc: SignDocumentDto) => void }>) {
  const { t } = useI18n();
  const td = t.weldsign.editor.documents;
  return (
    <>
      {docs.documents.length === 0 ? (
        <p className="text-sm text-muted-foreground">{td.emptyTitle}</p>
      ) : (
        // The list runs the full width of the panel, past the section's padding, and ends on a divider like its rows.
        <div className="-mx-5 border-b border-gray-200/70 dark:border-border">
          <TabListScope>
            <EntityList<SignDocumentDto>
              items={docs.documents}
              isLoading={false}
              headerColumns={documentColumns(td)}
              filters={[]}
              hideTopBar
              renderRow={(doc) => <DocumentRow key={doc.id} docs={docs} doc={doc} onOpen={() => onOpen(doc)} className={PANEL_ROW} />}
            />
          </TabListScope>
        </div>
      )}
      {docs.canAdd && (
        <div>
          <AddDocumentMenu docs={docs} />
        </div>
      )}
    </>
  );
}

/** A template's documents step: the list as the platform's lists are, the add buttons by the title. */
export function DocumentsStep({ envelope, editable }: Readonly<{ envelope: SignEnvelopeDetail; editable: boolean }>) {
  const { t } = useI18n();
  const td = t.weldsign.editor.documents;
  const docs = useDocuments(envelope, editable);
  const { documents } = docs;

  return (
    <div className="relative min-h-full" {...docs.dropHandlers}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{td.title}</h2>
            <p className="text-sm text-muted-foreground">{td.description}</p>
          </div>
          {docs.canAdd && documents.length > 0 && (
            <div className="flex items-center gap-2">
              <AddDocumentButtons docs={docs} />
            </div>
          )}
        </div>

        {documents.length === 0 ? (
          <DocumentsEmptyState docs={docs} />
        ) : (
          <TabListScope>
            <EntityList<SignDocumentDto>
              items={documents}
              isLoading={false}
              headerColumns={documentColumns(td)}
              filters={[]}
              hideTopBar
              renderRow={(doc) => <DocumentRow key={doc.id} docs={docs} doc={doc} />}
            />
          </TabListScope>
        )}
      </div>

      {docs.dragOver && <DropOverlay />}
      <DocumentDialogs docs={docs} />
    </div>
  );
}

/** Two stacked pages, the drawing of the WeldFlow project documents page. */
function PdfDrawing() {
  return (
    <svg width="150" height="120" viewBox="0 0 150 120" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ marginLeft: 3 }}>
      <rect x="38" y="14" width="74" height="92" rx="6" className="fill-white dark:fill-white/[0.03]" />
      <rect x="38" y="14" width="74" height="92" rx="6" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
      <rect x="28" y="22" width="74" height="92" rx="6" className="fill-white dark:fill-white/[0.04]" />
      <rect x="28" y="22" width="74" height="92" rx="6" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
      <rect x="38" y="40" width="54" height="5" rx="2" className="fill-gray-300 dark:fill-white/25" />
      <rect x="38" y="54" width="52" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" opacity="0.8" />
      <rect x="38" y="63" width="48" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" opacity="0.8" />
      <rect x="38" y="72" width="44" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" opacity="0.8" />
      <rect x="38" y="81" width="50" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" opacity="0.6" />
      <rect x="38" y="90" width="34" height="3" rx="1.5" className="fill-gray-200 dark:fill-white/15" opacity="0.4" />
    </svg>
  );
}
