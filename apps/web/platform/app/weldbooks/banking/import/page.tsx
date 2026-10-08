import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type DragEvent } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { AlertCircle, ArrowLeft, CheckCircle2, FileText, Loader2, Upload } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { readTextFile } from '@/lib/read-text-file';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import { isUsJurisdictionCode } from '@/lib/weldbooks/us-entity';
import {
  useBankAccounts,
  useBankImportPreview,
  useImportBankStatement,
} from '@/hooks/queries/use-weldbooks-banking-queries';
import {
  errorDetails,
  isWeldbooksRequestError,
  type ImportPreviewInput,
  type ImportProblem,
  type ImportStatementResult,
  type UsBankAccount,
} from '@/lib/api/domains/weldbooks-banking';
import { CsvFormatEditor } from '../components/csv-format-editor';
import {
  draftFromFormat,
  EMPTY_CSV_DRAFT,
  formatFromDraft,
  readCsvTable,
  type CsvFormatDraft,
} from '../components/csv-format-model';
import { ImportPreviewPanel, problemMessage } from '../components/import-preview-panel';
import { maskedAccountNumber } from '../components/routing-number';

const ACCEPTED_FILES = '.ofx,.qfx,.qbo,.bai,.bai2,.txt,.csv,.sta,.mt940,.940,.xml';

interface PickedFile {
  name: string;
  content: string;
}

type Mismatch = Pick<ImportProblem, 'code' | 'message' | 'details'>;

export default function BankImportPage() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { accountId?: string };
  const { t } = useI18n();
  const ti = t.weldbooksUs.banking.import;
  const tp = t.weldbooksUs.banking.importPreview;
  const accountTypeLabels = t.weldbooksUs.banking.accountTypes;
  const { can } = usePermissions();
  const { code: jurisdictionCode } = useCurrentJurisdiction();
  const isUs = isUsJurisdictionCode(jurisdictionCode);
  const { formatMoney, formatDate } = useWeldbooksFormat();

  const { data: accountsRes, isLoading: accountsLoading } = useBankAccounts();
  const accounts = useMemo(() => (accountsRes?.data ?? []).filter((a) => a.isActive !== false), [accountsRes]);

  const [accountId, setAccountId] = useState(search.accountId ?? '');
  const [file, setFile] = useState<PickedFile | null>(null);
  const [readError, setReadError] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [draft, setDraft] = useState<CsvFormatDraft | null>(null);
  const [dateOrderAmbiguous, setDateOrderAmbiguous] = useState(false);
  const [dateOrderConfirmed, setDateOrderConfirmed] = useState(true);
  const [serverWarnings, setServerWarnings] = useState<string[]>([]);
  const [remember, setRemember] = useState(true);
  const [mismatch, setMismatch] = useState<Mismatch | null>(null);
  const [result, setResult] = useState<ImportStatementResult | null>(null);

  const bankAccount: UsBankAccount | undefined = accounts.find((a) => a.id === accountId);

  // What the editor shows, and the layout it produces.
  const table = useMemo(() => (file && draft ? readCsvTable(file.content, draft) : null), [file, draft]);
  const csvFormat = useMemo(() => (draft && table ? formatFromDraft(draft, table.headers) : null), [draft, table]);

  const previewInput = useMemo<ImportPreviewInput | null>(
    () =>
      accountId && file
        ? { bankAccountId: accountId, content: file.content, fileName: file.name, ...(csvFormat ? { csvFormat } : {}) }
        : null,
    [accountId, file, csvFormat],
  );
  const previewQuery = useBankImportPreview(previewInput);
  const preview = previewQuery.data;
  const parsed = preview && !preview.needsCsvFormat ? preview : null;

  const importMutation = useImportBankStatement();

  const resetLayout = useCallback(() => {
    setDraft(null);
    setDateOrderAmbiguous(false);
    setDateOrderConfirmed(true);
    setServerWarnings([]);
  }, []);

  // A CSV without a known layout: start the editor from the server's proposal.
  useEffect(() => {
    if (!file || draft || !preview?.needsCsvFormat || !preview.proposal) return;
    setDraft(draftFromFormat(preview.proposal.format, preview.proposal.headers));
    setDateOrderAmbiguous(preview.proposal.dateOrderAmbiguous);
    setDateOrderConfirmed(!preview.proposal.dateOrderAmbiguous);
    setServerWarnings(preview.proposal.warnings);
  }, [file, draft, preview]);

  const pickFile = useCallback(
    (picked: File) => {
      setReadError(false);
      setResult(null);
      resetLayout();
      readTextFile(picked)
        .then((content) => setFile({ name: picked.name, content }))
        .catch(() => setReadError(true));
    },
    [resetLayout],
  );

  const handleFileInput = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    if (picked) pickFile(picked);
    // Picking the same file again must fire a change.
    e.target.value = '';
  };

  const handleDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    setDragging(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) pickFile(dropped);
  };

  const openLayoutEditor = () => {
    if (!file) return;
    const remembered = bankAccount?.importSettings?.csv;
    if (remembered) {
      const rememberedTable = readCsvTable(file.content, {
        delimiter: remembered.delimiter ?? null,
        skipRows: remembered.skipRows,
        hasHeader: remembered.hasHeader,
      });
      setDraft(draftFromFormat(remembered, rememberedTable.headers));
    } else if (preview?.proposal) {
      setDraft(draftFromFormat(preview.proposal.format, preview.proposal.headers));
      setServerWarnings(preview.proposal.warnings);
    } else {
      setDraft(EMPTY_CSV_DRAFT);
    }
    setDateOrderAmbiguous(false);
    setDateOrderConfirmed(true);
  };

  const changeAccount = (id: string) => {
    setAccountId(id);
    setResult(null);
    resetLayout();
  };

  const runImport = (ignoreAccountMismatch: boolean) => {
    if (!file || !accountId) return;
    setMismatch(null);
    importMutation.mutate(
      {
        bankAccountId: accountId,
        fileName: file.name,
        content: file.content,
        ...(draft && csvFormat ? { csvFormat, rememberCsvFormat: remember } : {}),
        ...(ignoreAccountMismatch ? { ignoreAccountMismatch: true } : {}),
      },
      {
        onSuccess: (imported) => setResult(imported),
        onError: (err) => {
          if (isWeldbooksRequestError(err) && err.status === 409 && (err.code === 'ACCOUNT_MISMATCH' || err.code === 'CURRENCY_MISMATCH')) {
            setMismatch({ code: err.code, message: err.message, details: errorDetails(err) ?? {} });
          }
        },
      },
    );
  };

  const handleImport = () => {
    if (parsed?.problem) setMismatch(parsed.problem);
    else runImport(false);
  };

  const layoutBlocksImport = !!draft && (!csvFormat || (dateOrderAmbiguous && !dateOrderConfirmed));
  const canImport =
    can('banking:create') &&
    !!parsed &&
    (parsed.totalParsed ?? 0) > 0 &&
    !layoutBlocksImport &&
    !previewQuery.isPlaceholderData &&
    !importMutation.isPending;
  const showLayoutButton = !draft && !!parsed && parsed.format === 'csv' && (!!bankAccount?.importSettings?.csv || !!parsed.proposal);
  const importError =
    importMutation.isError && !mismatch ? (importMutation.error as Error).message || ti.failedFallback : null;

  const accountLabel = (a: UsBankAccount) => {
    const parts = [a.name];
    if (a.accountType) parts.push(accountTypeLabels[a.accountType]);
    if (a.accountNumberLast4) parts.push(maskedAccountNumber(a.accountNumberLast4));
    else if (a.iban) parts.push(a.iban);
    return parts.join(' · ');
  };

  const reset = () => {
    setResult(null);
    setFile(null);
    resetLayout();
    importMutation.reset();
  };

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: '/weldbooks/banking' })} aria-label={ti.back}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-semibold">{ti.title}</h1>
          <p className="text-sm text-muted-foreground">{isUs ? ti.subtitleUs : ti.subtitleOther}</p>
        </div>
      </div>

      {result ? (
        <ImportResult
          result={result}
          accountId={accountId}
          onAnother={reset}
          formatMoney={(value) => formatMoney(value, result.currency ?? bankAccount?.currency)}
          formatDate={formatDate}
        />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{ti.stepAccount}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Label htmlFor="import-account">{ti.bankAccount}</Label>
              <Select value={accountId} onValueChange={changeAccount} disabled={accountsLoading}>
                <SelectTrigger id="import-account" className="max-w-xl" data-testid="import-account">
                  <SelectValue placeholder={ti.selectBankAccount} />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {accountLabel(a)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!accountsLoading && accounts.length === 0 ? (
                <p className="text-sm text-muted-foreground">{ti.noAccounts}</p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{ti.stepFile}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">{isUs ? ti.uploadHintUs : ti.uploadHintOther}</p>
              <label
                htmlFor="bank-file-input"
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={handleDrop}
                className={cn(
                  'flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed p-8 text-center transition-colors',
                  dragging ? 'border-primary bg-primary/5' : 'hover:bg-muted/40',
                )}
              >
                <Upload className="h-8 w-8 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">{ti.clickToSelect}</span>
                <input
                  type="file"
                  accept={ACCEPTED_FILES}
                  onChange={handleFileInput}
                  className="sr-only"
                  id="bank-file-input"
                  data-testid="bank-file-input"
                />
              </label>
              {file ? (
                <div className="flex items-center gap-2 text-sm">
                  <FileText className="h-4 w-4" />
                  <span>{file.name}</span>
                  <Badge variant="outline">{(file.content.length / 1024).toFixed(1)} KB</Badge>
                </div>
              ) : null}
              {readError ? (
                <p className="flex items-center gap-1 text-sm text-destructive" role="alert">
                  <AlertCircle className="h-4 w-4" />
                  {ti.readFailed}
                </p>
              ) : null}
            </CardContent>
          </Card>

          {file && accountId ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  {ti.stepReview}
                  {previewQuery.isFetching ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                {draft && table ? (
                  <CsvFormatEditor
                    draft={draft}
                    onDraftChange={setDraft}
                    table={table}
                    dateOrderAmbiguous={dateOrderAmbiguous}
                    dateOrderConfirmed={dateOrderConfirmed}
                    onDateOrderConfirmedChange={setDateOrderConfirmed}
                    warnings={serverWarnings}
                    remember={remember}
                    onRememberChange={setRemember}
                  />
                ) : null}

                {previewQuery.isError ? (
                  <p className="flex items-center gap-1 text-sm text-destructive" role="alert">
                    <AlertCircle className="h-4 w-4" />
                    {(previewQuery.error as Error).message || ti.previewFailed}
                  </p>
                ) : null}

                {previewQuery.isPending && !preview ? (
                  <p className="text-sm text-muted-foreground">{ti.reading}</p>
                ) : null}

                {parsed ? <ImportPreviewPanel preview={parsed} bankAccount={bankAccount} /> : null}

                {parsed && (parsed.totalParsed ?? 0) === 0 ? (
                  <p className="text-sm text-muted-foreground" data-testid="import-nothing">{ti.nothingToImport}</p>
                ) : null}

                {showLayoutButton ? (
                  <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/30 p-3 text-sm">
                    <span className="flex-1 min-w-[14rem] text-muted-foreground">
                      {bankAccount?.importSettings?.csv ? ti.layoutRemembered : ti.layoutDetected}
                    </span>
                    <Button type="button" variant="outline" size="sm" onClick={openLayoutEditor} data-testid="review-csv-layout">
                      {ti.reviewLayout}
                    </Button>
                  </div>
                ) : null}

                {importError ? (
                  <p className="flex items-center gap-1 text-sm text-destructive" role="alert">
                    <AlertCircle className="h-4 w-4" />
                    {ti.importFailed.replace('{error}', importError)}
                  </p>
                ) : null}

                {!can('banking:create') ? <p className="text-sm text-muted-foreground">{ti.noPermission}</p> : null}

                <div className="flex gap-3">
                  <Button onClick={handleImport} disabled={!canImport} data-testid="import-statement">
                    {importMutation.isPending ? (
                      <>
                        <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                        {ti.importing}
                      </>
                    ) : (
                      ti.import
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </>
      )}

      <ConfirmDialog
        open={mismatch !== null}
        onOpenChange={(open) => {
          if (!open) setMismatch(null);
        }}
        title={ti.mismatchTitle}
        description={mismatch ? `${problemMessage(mismatch, tp)} ${ti.mismatchQuestion}` : ''}
        confirmLabel={ti.importAnyway}
        cancelLabel={ti.pickAnother}
        onConfirm={() => runImport(true)}
      />
    </div>
  );
}

function ImportResult({
  result,
  accountId,
  onAnother,
  formatMoney,
  formatDate,
}: Readonly<{
  result: ImportStatementResult;
  accountId: string;
  onAnother: () => void;
  formatMoney: (value: number) => string;
  formatDate: (value: string) => string;
}>) {
  const { t } = useI18n();
  const ti = t.weldbooksUs.banking.import;
  const tp = t.weldbooksUs.banking.importPreview;

  return (
    <Card data-testid="import-result">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CheckCircle2 className="h-5 w-5 text-green-600" />
          {ti.completeTitle}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3 lg:grid-cols-5">
          <ResultStat label={ti.formatDetected}>
            <Badge variant="outline">{tp.formats[result.format]}</Badge>
          </ResultStat>
          <ResultStat label={ti.totalParsed}>{result.totalParsed}</ResultStat>
          <ResultStat label={ti.imported} testId="result-imported">{result.imported}</ResultStat>
          <ResultStat label={ti.duplicatesSkipped} testId="result-duplicates">{result.duplicates}</ResultStat>
          <ResultStat label={ti.autoReconciled} testId="result-auto-reconciled">{result.autoReconciled}</ResultStat>
        </div>
        {result.dateRange ? (
          <p className="text-sm text-muted-foreground">
            {ti.dateRange
              .replace('{from}', formatDate(result.dateRange.from))
              .replace('{to}', formatDate(result.dateRange.to))}
            {result.closingBalance === null ? '' : ` · ${ti.closingBalance.replace('{balance}', formatMoney(result.closingBalance))}`}
          </p>
        ) : null}
        {result.csvFormatRemembered ? <p className="text-sm text-muted-foreground">{ti.layoutSaved}</p> : null}
        {result.warning ? (
          <p className="text-sm text-amber-700 dark:text-amber-400" role="status">
            {problemMessage({ ...result.warning, details: {} }, tp)}
          </p>
        ) : null}
        {result.errors.length > 0 ? (
          <div>
            <p className="text-sm font-medium text-destructive">{ti.parseErrors}</p>
            <ul className="mt-1 space-y-0.5">
              {result.errors.map((err) => (
                <li key={`${err.line ?? ''}:${err.message}`} className="text-xs text-muted-foreground">
                  {err.line ? `${tp.line.replace('{line}', String(err.line))} ` : ''}
                  {err.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-3 pt-2">
          <Button variant="outline" onClick={onAnother}>{ti.importAnother}</Button>
          <Button variant="outline" asChild>
            <Link to="/weldbooks/banking/reconciliation">{ti.matchLines}</Link>
          </Button>
          <Button asChild>
            <Link to="/weldbooks/banking/$id" params={{ id: accountId }}>{ti.viewAccount}</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ResultStat({ label, children, testId }: Readonly<{ label: string; children: React.ReactNode; testId?: string }>) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-medium tabular-nums" data-testid={testId}>{children}</p>
    </div>
  );
}
