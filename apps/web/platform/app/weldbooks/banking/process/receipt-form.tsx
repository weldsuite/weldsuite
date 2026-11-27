/**
 * "Add a receipt": pick an unlinked inbox document or upload a file, then link
 * it to the bank line. Linking books nothing (booking the receipt itself comes
 * with the bills of phase 3), so once it is attached the form offers
 * "Book it to a category" right away.
 */

import { useId, useMemo, useRef, useState } from 'react';
import { CheckCircle2, FileText, Upload, Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { SearchInput } from '@weldsuite/ui/components/search-input';
import { Label } from '@weldsuite/ui/components/label';
import { useAttachDocumentToBankLine, useUnlinkedInboxDocuments } from '@/hooks/queries/use-weldbooks-processing-queries';
import { useFileUpload } from '@/hooks/use-file-upload';
import { accountingApi } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';

const ACCEPTED_TYPES = 'application/pdf,.pdf,image/jpeg,image/jpg,image/png,image/webp';

export interface ReceiptFormProps {
  lineId: string;
  onBookNow: () => void;
  onClose: () => void;
  /** Called once a document is linked (the queue and counts refresh). */
  onAttached?: (fileName: string) => void;
}

function messageOf(error: unknown): string | null {
  return error instanceof Error && error.message ? error.message : null;
}

export function ReceiptForm({ lineId, onBookNow, onClose, onAttached }: Readonly<ReceiptFormProps>) {
  const { t } = useI18n();
  const tr = t.weldbooksConnected.processing.receipt;
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

  const upload = async (file: File) => {
    setProblem(null);
    setUploading(true);
    try {
      const uploaded = await fileUpload.uploadFile(file);
      if (!uploaded) {
        setProblem(tr.uploadFailed);
        return;
      }
      const created = await accountingApi.createDocument({
        fileName: uploaded.fileName,
        fileKey: uploaded.fileKey,
        mimeType: uploaded.mimeType,
        fileSize: uploaded.fileSize,
        source: 'upload',
      });
      const documentId = created?.data?.id;
      if (!documentId) {
        setProblem(tr.uploadFailed);
        return;
      }
      link(documentId, uploaded.fileName);
    } catch (error) {
      setProblem(messageOf(error) ?? tr.uploadFailed);
    } finally {
      setUploading(false);
    }
  };

  if (attached) {
    return (
      <div className="space-y-3 rounded-xl border border-emerald-300/60 bg-emerald-50/60 p-5 dark:border-emerald-900 dark:bg-emerald-950/30" role="status" data-testid="receipt-attached">
        <p className="flex items-center gap-2 text-sm font-medium text-emerald-900 dark:text-emerald-200">
          <CheckCircle2 className="h-4 w-4" aria-hidden />
          {tr.attached}
        </p>
        <p className="text-xs text-muted-foreground">{tr.bookNowHint}</p>
        <div className="flex items-center gap-2">
          <Button type="button" onClick={onBookNow} data-testid="receipt-book-now">
            {tr.bookNow}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {tr.close}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <section aria-labelledby={`${ids}-title`} className="space-y-3 rounded-xl border p-5" data-testid="receipt-form">
      <div>
        <h3 id={`${ids}-title`} className="text-sm font-semibold">
          {tr.title}
        </h3>
        <p className="text-xs text-muted-foreground">{tr.hint}</p>
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
            <li key={doc.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="flex min-w-0 items-center gap-2 text-sm">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate">{doc.fileName}</span>
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={attach.isPending}
                onClick={() => link(doc.id, doc.fileName)}
                aria-label={tr.attach.replace('{name}', doc.fileName)}
              >
                {attach.isPending && attach.variables?.documentId === doc.id ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : null}
                {tr.attachShort}
              </Button>
            </li>
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
        <Button type="button" variant="outline" size="sm" disabled={uploading} onClick={() => fileInput.current?.click()}>
          {uploading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : <Upload className="h-4 w-4" />}
          {uploading ? tr.uploading : tr.upload}
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
