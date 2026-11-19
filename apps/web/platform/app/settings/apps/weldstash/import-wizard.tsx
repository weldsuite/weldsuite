/**
 * Sales history CSV import: choose a file, map its columns, upload it in
 * chunks of 1,000 rows, look at what matched, then finish (or discard).
 *
 * The file is parsed in the browser. Matching SKUs and warehouse codes is the
 * server's job, so the "matched / unmatched" check happens after the upload
 * and before the import is completed: nothing counts as demand until Finish,
 * and Discard deletes the import with its rows.
 */

import { useMemo, useRef, useState } from 'react';
import { FileSpreadsheet } from 'lucide-react';
import { toast } from 'sonner';
import { IMPORT_CHUNK_SIZE, type ReplenishmentSettings } from '@weldsuite/app-api-client/schemas/replenishment';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { InlineError } from '@weldsuite/ui/components/error-banner';
import { Label } from '@weldsuite/ui/components/label';
import { Progress } from '@weldsuite/ui/components/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { getLocale, getTranslations } from '@/lib/i18n';
import {
  useAddSalesHistoryRows,
  useCompleteSalesHistoryImport,
  useCreateSalesHistoryImport,
  useDeleteSalesHistoryImport,
  useUpdateReplenishmentSettings,
} from '@/hooks/queries/use-replenishment-queries';
import { formatDate } from '@/app/weldstash/lib/numbers';
import {
  EMPTY_MAPPING,
  chunkRows,
  guessMapping,
  isMappingComplete,
  mapRows,
  parseCsv,
  type ColumnMapping,
  type DateFormat,
} from '@/app/weldstash/replenishment/lib/csv';

type Step = 'file' | 'map' | 'upload' | 'review' | 'done';

const NOT_IN_FILE = '-1';
/** The server keeps the first 100 unmatched SKUs of an import; the wizard shows as many as it is told. */
const MAX_UNMATCHED_SHOWN = 100;

interface ImportWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: ReplenishmentSettings;
}

export function ImportWizard({ open, onOpenChange, settings }: Readonly<ImportWizardProps>) {
  const t = getTranslations('weldstashReplenishment').wizard;
  const locale = getLocale();
  const createImport = useCreateSalesHistoryImport();
  const addRows = useAddSalesHistoryRows();
  const completeImport = useCompleteSalesHistoryImport();
  const deleteImport = useDeleteSalesHistoryImport();
  const updateSettings = useUpdateReplenishmentSettings();

  const [step, setStep] = useState<Step>('file');
  const [fileName, setFileName] = useState('');
  const [table, setTable] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<ColumnMapping>(EMPTY_MAPPING);
  const [dateFormat, setDateFormat] = useState<DateFormat>('auto');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [importId, setImportId] = useState<string | null>(null);
  const [totals, setTotals] = useState({ imported: 0, skipped: 0, unmatched: [] as string[] });
  const [cutover, setCutover] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Bumped when the wizard closes, so an upload still running stops and removes its import.
  const uploadSession = useRef(0);

  const headers = table[0] ?? [];
  const dataRows = useMemo(() => table.slice(1), [table]);
  const mapped = useMemo(() => mapRows(dataRows, mapping, dateFormat), [dataRows, mapping, dateFormat]);
  // The first rows as they will be sent; a row's place in the file is its identity.
  const preview = useMemo(() => mapped.rows.slice(0, 5).map((row, place) => ({ id: `row-${place}`, row })), [mapped.rows]);

  const reset = () => {
    setStep('file');
    setFileName('');
    setTable([]);
    setMapping(EMPTY_MAPPING);
    setError(null);
    setProgress(0);
    setImportId(null);
    setTotals({ imported: 0, skipped: 0, unmatched: [] });
    setCutover(null);
  };

  const close = async (next: boolean) => {
    if (!next) {
      uploadSession.current += 1;
      // Closing with an unfinished import deletes it: its rows are not demand until Finish.
      if (importId && step !== 'done') await deleteImport.mutateAsync(importId).catch(() => undefined);
      reset();
    }
    onOpenChange(next);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const rows = parseCsv(await file.text());
      if (rows.length < 2) {
        setError(t.emptyFile);
        return;
      }
      setFileName(file.name);
      setTable(rows);
      setMapping(guessMapping(rows[0]));
      setStep('map');
    } catch {
      setError(t.readFailed);
    }
  };

  /** Deletes an import the wizard no longer shows; a failure leaves it unfinished, which is not demand either. */
  const discardImport = async (id: string) => {
    await deleteImport.mutateAsync(id).catch(() => undefined);
  };

  /** Sends the rows in chunks; null when the wizard closed on the way. */
  const uploadChunks = async (id: string, closed: () => boolean) => {
    const chunks = chunkRows(mapped.rows, IMPORT_CHUNK_SIZE);
    const totalsSoFar = { imported: 0, skipped: 0, unmatched: new Set<string>() };
    for (const [index, rows] of chunks.entries()) {
      const result = await addRows.mutateAsync({ id, data: { rows, startRow: index * IMPORT_CHUNK_SIZE } });
      if (closed()) return null;
      totalsSoFar.imported += result.imported;
      totalsSoFar.skipped += result.skipped;
      for (const sku of result.unmatchedSkus) if (totalsSoFar.unmatched.size < MAX_UNMATCHED_SHOWN) totalsSoFar.unmatched.add(sku);
      setProgress(Math.round(((index + 1) / chunks.length) * 100));
    }
    return totalsSoFar;
  };

  const upload = async () => {
    const session = ++uploadSession.current;
    const closed = () => uploadSession.current !== session;
    setStep('upload');
    setError(null);
    setProgress(0);
    let id = importId;
    try {
      if (!id) {
        id = (await createImport.mutateAsync(fileName)).id;
        if (!closed()) setImportId(id);
      }
      const sent = closed() ? null : await uploadChunks(id, closed);
      if (!sent) {
        await discardImport(id);
        return;
      }
      setTotals({ imported: sent.imported, skipped: sent.skipped, unmatched: [...sent.unmatched] });
      setStep('review');
    } catch (err) {
      // A half-uploaded import is discarded, so a retry starts clean.
      if (id) await discardImport(id);
      if (closed()) return;
      setError((err as Error).message || t.uploadFailed);
      setStep('map');
      setImportId(null);
    }
  };

  const finish = async () => {
    if (!importId) return;
    try {
      const result = await completeImport.mutateAsync(importId);
      setCutover(settings.historyCutoverDate ? null : result.suggestedCutoverDate);
      setStep('done');
    } catch (err) {
      setError((err as Error).message || t.completeFailed);
    }
  };

  const discard = async () => {
    if (importId) await deleteImport.mutateAsync(importId).catch(() => undefined);
    reset();
    onOpenChange(false);
  };

  const applyCutover = async () => {
    if (!cutover) return;
    try {
      await updateSettings.mutateAsync({ historyCutoverDate: cutover });
      toast.success(t.cutoverSet);
      setCutover(null);
    } catch (err) {
      toast.error((err as Error).message || t.cutoverFailed);
    }
  };

  const columnSelect = (field: keyof ColumnMapping, label: string, required: boolean) => (
    <div className="grid gap-1.5">
      <Label>
        {label}
        {required && <span className="ml-1 text-destructive">*</span>}
      </Label>
      <Select
        value={String(mapping[field])}
        onValueChange={(value) => setMapping((current) => ({ ...current, [field]: Number(value) }))}
      >
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {!required && <SelectItem value={NOT_IN_FILE}>{t.notInFile}</SelectItem>}
          {required && mapping[field] === -1 && <SelectItem value={NOT_IN_FILE}>{t.chooseColumn}</SelectItem>}
          {headers.map((header, index) => (
            <SelectItem key={`${header}-${index}`} value={String(index)}>
              {header || t.columnN.replace('{n}', String(index + 1))}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  const errorLabel = { date: t.errorDate, sku: t.errorSku, quantity: t.errorQuantity };

  return (
    <Dialog open={open} onOpenChange={(next) => void close(next)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription>{t.steps[step]}</DialogDescription>
        </DialogHeader>

        {step === 'file' && (
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="flex w-full flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center transition-colors hover:bg-accent/40"
            >
              <FileSpreadsheet className="size-8 text-muted-foreground/60" aria-hidden />
              <span className="text-sm font-medium">{t.chooseFile}</span>
              <span className="max-w-sm text-xs text-muted-foreground">{t.fileHint}</span>
            </button>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.txt,text/csv"
              className="sr-only"
              aria-label={t.chooseFile}
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
            {error && <InlineError>{error}</InlineError>}
          </div>
        )}

        {step === 'map' && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t.fileSummary.replace('{file}', fileName).replace('{rows}', String(dataRows.length))}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {columnSelect('date', t.fields.date, true)}
              {columnSelect('sku', t.fields.sku, true)}
              {columnSelect('quantity', t.fields.quantity, true)}
              {columnSelect('warehouseCode', t.fields.warehouseCode, false)}
              {columnSelect('reference', t.fields.reference, false)}
              <div className="grid gap-1.5">
                <Label>{t.dateFormat}</Label>
                <Select value={dateFormat} onValueChange={(value) => setDateFormat(value as DateFormat)}>
                  <SelectTrigger aria-label={t.dateFormat}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">{t.dateFormats.auto}</SelectItem>
                    <SelectItem value="dmy">{t.dateFormats.dmy}</SelectItem>
                    <SelectItem value="mdy">{t.dateFormats.mdy}</SelectItem>
                    <SelectItem value="ymd">{t.dateFormats.ymd}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {isMappingComplete(mapping) && (
              <div className="space-y-2 rounded-md border p-3 text-sm">
                <p>
                  {t.preview
                    .replace('{valid}', String(mapped.rows.length))
                    .replace('{skus}', String(mapped.distinctSkus))
                    .replace('{from}', formatDate(mapped.dateFrom, locale))
                    .replace('{to}', formatDate(mapped.dateTo, locale))}
                </p>
                {mapped.rows.length > 0 && (
                  <ul className="space-y-0.5 text-xs text-muted-foreground tabular-nums">
                    {preview.map(({ id, row }) => (
                      <li key={id}>
                        {row.date} · {row.sku} · {row.quantity}
                        {row.warehouseCode ? ` · ${row.warehouseCode}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
                {mapped.errors.length > 0 && (
                  <InfoBanner variant="warning" title={t.rowErrors.replace('{count}', String(mapped.errors.length))}>
                    <ul className="list-disc pl-4 text-xs">
                      {mapped.errors.slice(0, 5).map((e) => (
                        <li key={`${e.line}-${e.code}`}>{t.errorLine.replace('{line}', String(e.line)).replace('{problem}', errorLabel[e.code]).replace('{value}', e.value)}</li>
                      ))}
                    </ul>
                  </InfoBanner>
                )}
              </div>
            )}
            {error && <InlineError>{error}</InlineError>}
          </div>
        )}

        {step === 'upload' && (
          <div className="space-y-3 py-4">
            <Progress value={progress} aria-label={t.uploading} />
            <p className="text-sm text-muted-foreground">{t.uploadingRows.replace('{percent}', String(progress))}</p>
          </div>
        )}

        {step === 'review' && (
          <div className="space-y-3">
            <p className="text-sm">{t.reviewSummary.replace('{imported}', String(totals.imported)).replace('{skipped}', String(totals.skipped))}</p>
            {totals.skipped > 0 && (
              <InfoBanner variant="warning" title={t.unmatchedTitle}>
                <p>{t.unmatchedBody}</p>
                {totals.unmatched.length > 0 && (
                  <p className="mt-1 break-words font-mono text-xs">{totals.unmatched.join(', ')}</p>
                )}
              </InfoBanner>
            )}
            {totals.imported === 0 && <InlineError>{t.nothingMatched}</InlineError>}
            {error && <InlineError>{error}</InlineError>}
          </div>
        )}

        {step === 'done' && (
          <div className="space-y-3">
            <InfoBanner variant="success">{t.doneBody}</InfoBanner>
            {cutover && (
              <InfoBanner
                variant="tip"
                title={t.cutoverTitle}
                action={
                  <Button size="sm" variant="outline" disabled={updateSettings.isPending} onClick={() => void applyCutover()}>
                    {t.cutoverApply.replace('{date}', formatDate(cutover, locale))}
                  </Button>
                }
              >
                {t.cutoverBody.replace('{date}', formatDate(cutover, locale))}
              </InfoBanner>
            )}
          </div>
        )}

        <DialogFooter>
          {step === 'file' && (
            <Button variant="outline" onClick={() => void close(false)}>
              {t.cancel}
            </Button>
          )}
          {step === 'map' && (
            <>
              <Button variant="outline" onClick={reset}>
                {t.back}
              </Button>
              <Button disabled={!isMappingComplete(mapping) || mapped.rows.length === 0} onClick={() => void upload()}>
                {t.upload.replace('{count}', String(mapped.rows.length))}
              </Button>
            </>
          )}
          {step === 'review' && (
            <>
              <Button variant="outline" onClick={() => void discard()}>
                {t.discard}
              </Button>
              <Button disabled={totals.imported === 0 || completeImport.isPending} onClick={() => void finish()}>
                {t.finish}
              </Button>
            </>
          )}
          {step === 'done' && <Button onClick={() => void close(false)}>{t.done}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
