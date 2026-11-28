/**
 * "Add a receipt": pick an unlinked inbox document or upload a file. Where the
 * edition books documents (`books-receipts`) that books it as a receipt paid
 * with this bank line, from the scan and the supplier's history: one step, and
 * the line is done. Elsewhere it only links the document to the line, so once
 * it is attached the form offers "Book it to a category" right away.
 */

import { useId, useMemo, useRef, useState } from 'react';
import { CheckCircle2, FileText, Upload, Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { SearchInput } from '@weldsuite/ui/components/search-input';
import { Label } from '@weldsuite/ui/components/label';
import { useQueryClient } from '@tanstack/react-query';
import {
  invalidateAfterProcessing,
  useAttachDocumentToBankLine,
  useUnlinkedInboxDocuments,
} from '@/hooks/queries/use-weldbooks-processing-queries';
import { isReceiptsAvailable, useBookDocument } from '@/hooks/queries/use-weldbooks-receipts-queries';
import { useFileUpload } from '@/hooks/use-file-upload';
import { accountingApi } from '@/lib/api/domains/weldbooks';
import { receiptsApi } from '@/lib/api/domains/weldbooks-receipts';
import { isFeatureAvailable } from '@/lib/edition';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { receiptBookInput } from './receipt-booking';

const ACCEPTED_TYPES = 'application/pdf,.pdf,image/jpeg,image/jpg,image/png,image/webp';

export interface ReceiptFormProps {
  lineId: string;
  /** The bank line's date: the receipt's date when the scan read none. */
  lineDate?: string;
  onBookNow: () => void;
  onClose: () => void;
  /** Called once a document is linked (the queue and counts refresh). */
  onAttached?: (fileName: string) => void;
  /** Called once the document is booked as a receipt and the line is done (`books-receipts`). */
  onBooked?: (fileName: string) => void;
}

function messageOf(error: unknown): string | null {
  return error instanceof Error && error.message ? error.message : null;
}

type ReceiptCopy = ReturnType<typeof useI18n>['t']['weldbooksConnected']['processing']['receipt'];
type ReceiptBookingCopy = ReturnType<typeof useI18n>['t']['weldbooksReceipts']['receiptBooking'];

function uploadLabel(uploading: boolean, books: boolean, tr: ReceiptCopy, trb: ReceiptBookingCopy): string {
  if (uploading) return tr.uploading;
  return books ? trb.uploadAndBook : tr.upload;
}

/** Uploads the file and registers it as an inbox document, or null when either step fails. */
async function createUploadedDocument(
  uploadFile: (file: File) => Promise<{ fileName: string; fileKey: string; mimeType: string; fileSize: number } | null | undefined>,
  file: File,
): Promise<{ documentId: string; fileName: string } | null> {
  const uploaded = await uploadFile(file);
  if (!uploaded) return null;
  const created = await accountingApi.createDocument({
    fileName: uploaded.fileName,
    fileKey: uploaded.fileKey,
    mimeType: uploaded.mimeType,
    fileSize: uploaded.fileSize,
    source: 'upload',
  });
  const documentId = created?.data?.id;
  return documentId ? { documentId, fileName: uploaded.fileName } : null;
}

/** The confirmation once a document is attached (or booked as a receipt). */
function ReceiptAttached({ books, onBookNow, onClose }: Readonly<{ books: boolean; onBookNow: () => void; onClose: () => void }>) {
  const { t } = useI18n();
  const tr = t.weldbooksConnected.processing.receipt;
  const trb = t.weldbooksReceipts.receiptBooking;
  return (
    <div className="space-y-3 rounded-xl border border-emerald-300/60 bg-emerald-50/60 p-5 dark:border-emerald-900 dark:bg-emerald-950/30" role="status" data-testid="receipt-attached">
      <p className="flex items-center gap-2 text-sm font-medium text-emerald-900 dark:text-emerald-200">
        <CheckCircle2 className="h-4 w-4" aria-hidden />
        {books ? trb.booked : tr.attached}
      </p>
      {books ? null : <p className="text-xs text-muted-foreground">{tr.bookNowHint}</p>}
      <div className="flex items-center gap-2">
        {books ? null : (
          <Button type="button" onClick={onBookNow} data-testid="receipt-book-now">
            {tr.bookNow}
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={onClose}>
          {tr.close}
        </Button>
      </div>
    </div>
  );
}

/** One unlinked inbox document with its attach (or book) button. */
function ReceiptDocumentRow({
  doc,
  books,
  disabled,
  busy,
  booking,
  onAction,
}: Readonly<{
  doc: { id: string; fileName: string };
  books: boolean;
  disabled: boolean;
  busy: boolean;
  booking: boolean;
  onAction: () => void;
}>) {
  const { t } = useI18n();
  const tr = t.weldbooksConnected.processing.receipt;
  const trb = t.weldbooksReceipts.receiptBooking;
  let label = tr.attachShort;
  if (books) label = booking ? trb.booking : trb.book;
  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2">
      <span className="flex min-w-0 items-center gap-2 text-sm">
        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate">{doc.fileName}</span>
      </span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={onAction}
        aria-label={books ? `${trb.book}: ${doc.fileName}` : tr.attach.replace('{name}', doc.fileName)}
      >
        {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : null}
        {label}
      </Button>
    </li>
  );
}

export function ReceiptForm({ lineId, lineDate, onBookNow, onClose, onAttached, onBooked }: Readonly<ReceiptFormProps>) {
  const { t } = useI18n();
  const tr = t.weldbooksConnected.processing.receipt;
  const trb = t.weldbooksReceipts.receiptBooking;
  const books = isReceiptsAvailable();
  const qc = useQueryClient();
  const { today } = useWeldbooksFormat();
  const bookDocument = useBookDocument();
  const [booking, setBooking] = useState<string | null>(null);
  const ids = useId();
  const [search, setSearch] = useState('');
  const [attached, setAttached] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const documents = useUnlinkedInboxDocuments();
  const attach = useAttachDocumentToBankLine();
  const fileUpload = useFileUpload({ folder: 'weldbooks/documents', entityType: 'accounting_document', isPublic: false });

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const rows = documents.data ?? [];
    return needle ? rows.filter((doc) => doc.fileName.toLowerCase().includes(needle)) : rows;
  }, [documents.data, search]);

  const link = (documentId: string, fileName: string) => {
    setProblem(null);
    attach.mutate(
      { lineId, documentId },
      {
        onSuccess: () => {
          setAttached(fileName);
          onAttached?.(fileName);
        },
        onError: (error) => setProblem(messageOf(error)),
      },
    );
  };

  /** Books the document as a receipt paid with this line, or says why it cannot be done in one step. */
  const bookIt = async (documentId: string, fileName: string): Promise<boolean> => {
    setProblem(null);
    setBooking(documentId);
    try {
      const prefill = (await receiptsApi.getPrefill(documentId)).data;
      const plan = receiptBookInput(prefill, lineId, lineDate ?? today());
      if (!plan.ok) {
        setProblem(plan.problem === 'noSupplier' ? trb.noSupplier : trb.noLines);
        return false;
      }
      await bookDocument.mutateAsync({ id: documentId, input: plan.input });
      invalidateAfterProcessing(qc);
      setAttached(fileName);
      onBooked?.(fileName);
      return true;
    } catch (error) {
      setProblem(messageOf(error) ?? trb.failed);
      return false;
    } finally {
      setBooking(null);
    }
  };

  const upload = async (file: File) => {
    setProblem(null);
    setUploading(true);
    try {
      const created = await createUploadedDocument(fileUpload.uploadFile, file);
      if (!created) {
        setProblem(tr.uploadFailed);
        return;
      }
      if (!books) {
        link(created.documentId, created.fileName);
        return;
      }
      // The scan has to be read before the receipt can be booked from it.
      if (isFeatureAvailable('books-ocr')) await accountingApi.processDocument(created.documentId);
      await bookIt(created.documentId, created.fileName);
    } catch (error) {
      setProblem(messageOf(error) ?? tr.uploadFailed);
    } finally {
      setUploading(false);
    }
  };

  if (attached) return <ReceiptAttached books={books} onBookNow={onBookNow} onClose={onClose} />;

  return (
    <section aria-labelledby={`${ids}-title`} className="space-y-3 rounded-xl border p-5" data-testid="receipt-form">
      <div>
        <h3 id={`${ids}-title`} className="text-sm font-semibold">
          {tr.title}
        </h3>
        <p className="text-xs text-muted-foreground">{books ? trb.hint : tr.hint}</p>
      </div>

      <div className="space-y-1">
        <Label htmlFor={`${ids}-search`}>{tr.searchLabel}</Label>
        <SearchInput
          id={`${ids}-search`}
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={tr.searchPlaceholder}
          autoComplete="off"
        />
      </div>

      {documents.isLoading ? <InlineSpinner /> : null}
      {!documents.isLoading && shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">{search.trim() ? tr.noResults : tr.empty}</p>
      ) : null}
      {shown.length > 0 ? (
        <ul className="max-h-56 divide-y overflow-y-auto rounded-md border" data-testid="receipt-documents">
          {shown.map((doc) => (
            <ReceiptDocumentRow
              key={doc.id}
              doc={doc}
              books={books}
              disabled={attach.isPending || booking !== null}
              busy={(attach.isPending && attach.variables?.documentId === doc.id) || booking === doc.id}
              booking={booking === doc.id}
              onAction={() => (books ? void bookIt(doc.id, doc.fileName) : link(doc.id, doc.fileName))}
            />
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPTED_TYPES}
          className="sr-only"
          tabIndex={-1}
          aria-label={tr.upload}
          data-testid="receipt-file-input"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void upload(file);
          }}
        />
        <Button type="button" variant="outline" size="sm" disabled={uploading || booking !== null} onClick={() => fileInput.current?.click()}>
          {uploading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : <Upload className="h-4 w-4" />}
          {uploadLabel(uploading, books, tr, trb)}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {t.weldbooksConnected.processing.category.cancel}
        </Button>
      </div>

      {problem ? (
        <p className="text-sm text-destructive" role="alert" data-testid="receipt-error">
          {problem}
        </p>
      ) : null}
    </section>
  );
}
