import { useMemo, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, CheckCircle2, FileUp } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { useAccountingAccounts } from '@/hooks/queries/use-accounting-queries';
import { useImportPayrollCsv, usePayrollCsvMapping } from '@/hooks/queries/use-weldbooks-assets-queries';
import { csvProblemsFromError, type CsvImportResult, type CsvProblem } from '@/lib/api/domains/weldbooks-assets';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { AccountSelect } from '../../fixed-assets/components/account-select';
import { errorMessage, fill } from '../../fixed-assets/text';
import { CategoryMapping } from '../components/category-mapping';
import { ColumnMapping } from '../components/column-mapping';
import { DryRunReview } from '../components/dry-run-review';
import {
  buildCsvMapping,
  distinctValues,
  draftFromFile,
  draftFromSaved,
  emptyDraft,
  missingAccounts,
  missingColumns,
  parseCsv,
  type MappingDraft,
  type ParsedCsv,
} from '../csv-mapping';

type Step = 'upload' | 'shape' | 'columns' | 'accounts' | 'review' | 'done';
const STEPS: readonly Step[] = ['upload', 'shape', 'columns', 'accounts', 'review', 'done'];
/** The server refuses a file over this many characters. */
const MAX_FILE_BYTES = 5_000_000;

function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsText(file);
  });
}

/** Import payrolls from a CSV export: file, format, columns, accounts, a dry run to review, then the import. */
export default function PayrollImportPage() {
  const { t } = useI18n();
  const tw = t.weldbooksUs.assets.payroll.wizard;
  const common = t.weldbooksUs.assets.common;
  const { can } = usePermissions();
  const { formatDate } = useWeldbooksFormat();
  const accountsQuery = useAccountingAccounts();
  const savedMapping = usePayrollCsvMapping();
  const check = useImportPayrollCsv();
  const post = useImportPayrollCsv();
  const fileInput = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [draft, setDraft] = useState<MappingDraft>(emptyDraft);
  const [usedSaved, setUsedSaved] = useState(false);
  const [saveMapping, setSaveMapping] = useState(true);
  const [batchLabel, setBatchLabel] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [dryRun, setDryRun] = useState<CsvImportResult | null>(null);
  const [problems, setProblems] = useState<CsvProblem[] | null>(null);
  const [dryRunError, setDryRunError] = useState<string | null>(null);
  const [dryRunning, setDryRunning] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<CsvImportResult | null>(null);

  const parsed: ParsedCsv | null = useMemo(() => (file ? parseCsv(file.text) : null), [file]);
  const accountById = useMemo(() => new Map((accountsQuery.data?.data ?? []).map((account) => [account.id, account])), [accountsQuery.data]);
  const accountName = (id: string): string => {
    const account = accountById.get(id);
    return account ? `${account.code} — ${account.name}` : id;
  };
  const glLabels = useMemo(() => (parsed ? distinctValues(parsed, draft.glColumns.account) : []), [parsed, draft.glColumns.account]);

  if (!can('journal:create')) {
    return <div className="p-6 text-sm text-muted-foreground">{common.noAccess}</div>;
  }

  const onFile = async (selected: File | undefined) => {
    if (!selected) return;
    setFileError(null);
    if (selected.size > MAX_FILE_BYTES) {
      setFileError(tw.upload.tooLarge);
      return;
    }
    let text: string;
    try {
      text = await readFileText(selected);
    } catch {
      setFileError(tw.upload.unreadable);
      return;
    }
    const next = parseCsv(text);
    if (next.headers.length === 0 || next.rows.length === 0) {
      setFileError(tw.upload.empty);
      return;
    }
    const fromSaved = savedMapping.data ? draftFromSaved(savedMapping.data, next) : null;
    setFile({ name: selected.name, text });
    setDraft(fromSaved ?? draftFromFile(next));
    setUsedSaved(fromSaved !== null);
    setDryRun(null);
    setProblems(null);
    setDryRunError(null);
    setStep('shape');
  };

  const runDryRun = async () => {
    const mapping = buildCsvMapping(draft);
    if (!file || !mapping) return;
    setStep('review');
    setDryRun(null);
    setProblems(null);
    setDryRunError(null);
    setImportError(null);
    setDryRunning(true);
    try {
      const result = await check.mutateAsync({
        csv: file.text,
        mapping,
        sourceFileName: file.name,
        dryRun: true,
        ...(periodStart ? { periodStart } : {}),
        ...(periodEnd ? { periodEnd } : {}),
        ...(batchLabel.trim() ? { batchLabel: batchLabel.trim() } : {}),
      });
      setDryRun(result);
    } catch (err) {
      setProblems(csvProblemsFromError(err));
      setDryRunError(errorMessage(err));
    } finally {
      setDryRunning(false);
    }
  };

  const runImport = async () => {
    const mapping = buildCsvMapping(draft);
    if (!file || !mapping) return;
    setImportError(null);
    try {
      const result = await post.mutateAsync({
        csv: file.text,
        mapping,
        saveMapping,
        sourceFileName: file.name,
        dryRun: false,
        ...(periodStart ? { periodStart } : {}),
        ...(periodEnd ? { periodEnd } : {}),
        ...(batchLabel.trim() ? { batchLabel: batchLabel.trim() } : {}),
      });
      setOutcome(result);
      setStep('done');
      toast.success(fill(tw.done.imported, { count: result.imports.length }));
    } catch (err) {
      setImportError(errorMessage(err));
    }
  };

  const reset = () => {
    setStep('upload');
    setFile(null);
    setDraft(emptyDraft());
    setDryRun(null);
    setProblems(null);
    setDryRunError(null);
    setOutcome(null);
    setBatchLabel('');
    if (fileInput.current) fileInput.current.value = '';
  };

  const needColumns = missingColumns(draft);
  const needAccounts = missingAccounts(draft);
  const stepIndex = STEPS.indexOf(step);
  const fieldLabels = tw.columns.fields as Record<string, string>;

  return (
    <div className="max-w-5xl space-y-6 p-4 sm:p-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild aria-label={common.back}>
          <Link to="/weldbooks/payroll">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-semibold">{tw.title}</h1>
          <p className="text-sm text-muted-foreground">{tw.subtitle}</p>
        </div>
      </div>

      <ol className="flex flex-wrap gap-2 text-sm" aria-label={tw.stepsLabel}>
        {STEPS.map((id, index) => (
          <li
            key={id}
            aria-current={id === step ? 'step' : undefined}
            className={`rounded-full border px-3 py-1 ${id === step ? 'bg-primary text-primary-foreground' : index < stepIndex ? 'text-foreground' : 'text-muted-foreground'}`}
          >
            {index + 1}. {tw.steps[id]}
          </li>
        ))}
      </ol>

      {step === 'upload' ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{tw.upload.title}</CardTitle>
            <CardDescription>{tw.upload.description}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <input
              ref={fileInput}
              id="payroll-file"
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/plain"
              className="sr-only"
              data-testid="payroll-file"
              onChange={(event) => void onFile(event.target.files?.[0])}
            />
            <Button type="button" variant="outline" onClick={() => fileInput.current?.click()}>
              <FileUp className="h-4 w-4" />
              {tw.upload.choose}
            </Button>
            {fileError ? (
              <p className="text-sm text-destructive" role="alert" data-testid="file-error">
                {fileError}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {step !== 'upload' && file && parsed ? (
        <p className="text-sm text-muted-foreground" data-testid="file-summary">
          {file.name} · {fill(tw.upload.summary, { rows: parsed.rows.length, columns: parsed.headers.length })}
          {usedSaved ? ` · ${tw.upload.savedApplied}` : ''}
        </p>
      ) : null}

      {step === 'shape' ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{tw.shape.title}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <RadioGroup
              value={draft.shape}
              onValueChange={(value) => setDraft({ ...draft, shape: value as MappingDraft['shape'] })}
              className="grid gap-3 sm:grid-cols-2"
            >
              {(['summary', 'gl'] as const).map((shape) => (
                <Label
                  key={shape}
                  htmlFor={`shape-${shape}`}
                  className="flex cursor-pointer items-start gap-3 rounded-md border p-4 font-normal has-[[data-state=checked]]:border-primary"
                >
                  <RadioGroupItem id={`shape-${shape}`} value={shape} className="mt-1" />
                  <span className="space-y-1">
                    <span className="block text-sm font-medium">{tw.shape[shape].title}</span>
                    <span className="block text-sm text-muted-foreground">{tw.shape[shape].description}</span>
                  </span>
                </Label>
              ))}
            </RadioGroup>

            {parsed ? (
              <div className="space-y-2">
                <p className="text-sm font-medium">{tw.upload.previewTitle}</p>
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {parsed.headers.map((header) => (
                          <TableHead key={header}>{header}</TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {parsed.rows.slice(0, 5).map((row, index) => (
                        <TableRow key={index}>
                          {parsed.headers.map((header, column) => (
                            <TableCell key={header} className="whitespace-nowrap">
                              {row[column] ?? ''}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            ) : null}

            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={reset}>
                {tw.upload.chooseAnother}
              </Button>
              <Button type="button" onClick={() => setStep('columns')} data-testid="shape-continue">
                {tw.next}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {step === 'columns' && parsed ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{tw.columns.title}</CardTitle>
            <CardDescription>{draft.shape === 'summary' ? tw.columns.summaryDescription : tw.columns.glDescription}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ColumnMapping draft={draft} headers={parsed.headers} onChange={setDraft} />
            {needColumns.length > 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="columns-missing">
                {fill(tw.columns.missing, { fields: needColumns.map((key) => fieldLabels[key] ?? key).join(', ') })}
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => setStep('shape')}>
                {tw.back}
              </Button>
              <Button type="button" onClick={() => setStep('accounts')} disabled={needColumns.length > 0} data-testid="columns-continue">
                {tw.next}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {step === 'accounts' ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{tw.accounts.title}</CardTitle>
            <CardDescription>{draft.shape === 'summary' ? tw.accounts.summaryDescription : tw.accounts.glDescription}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {draft.shape === 'summary' ? (
              <CategoryMapping
                idPrefix="import-category"
                value={draft.summaryAccounts}
                onChange={(next) => setDraft({ ...draft, summaryAccounts: next })}
              />
            ) : glLabels.length === 0 ? (
              <p className="text-sm text-muted-foreground">{tw.accounts.glNoLabels}</p>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">{tw.accounts.glAutoHelp}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {glLabels.map((label, index) => (
                    <div key={label} className="space-y-1.5">
                      <Label htmlFor={`gl-label-${index}`}>{label}</Label>
                      <AccountSelect
                        id={`gl-label-${index}`}
                        value={draft.glAccounts[label] ?? ''}
                        onChange={(next) => {
                          const accounts = { ...draft.glAccounts };
                          if (next) accounts[label] = next;
                          else delete accounts[label];
                          setDraft({ ...draft, glAccounts: accounts });
                        }}
                        unsetLabel={tw.accounts.matchAutomatically}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
            {needAccounts.length > 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="accounts-missing">
                {tw.accounts.missingNetPay}
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => setStep('columns')}>
                {tw.back}
              </Button>
              <Button type="button" onClick={() => void runDryRun()} disabled={needAccounts.length > 0} data-testid="accounts-continue">
                {tw.accounts.check}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {step === 'review' ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{tw.review.title}</CardTitle>
            <CardDescription>{tw.review.description}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="import-period-start">{tw.review.periodStart}</Label>
                <Input id="import-period-start" type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="import-period-end">{tw.review.periodEnd}</Label>
                <Input id="import-period-end" type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="import-batch">{tw.review.batchLabel}</Label>
                <Input id="import-batch" value={batchLabel} onChange={(event) => setBatchLabel(event.target.value)} maxLength={100} />
                <p className="text-xs text-muted-foreground">{tw.review.batchLabelHelp}</p>
              </div>
            </div>

            <DryRunReview
              result={dryRun}
              problems={problems}
              errorMessage={dryRunError}
              loading={dryRunning}
              accountName={accountName}
              importing={post.isPending}
              canImport={can('journal:create')}
              onImport={() => void runImport()}
              onCheckAgain={() => void runDryRun()}
            />

            <div className="flex flex-wrap items-center gap-2">
              <Checkbox id="import-save-mapping" checked={saveMapping} onCheckedChange={(checked) => setSaveMapping(checked === true)} />
              <Label htmlFor="import-save-mapping" className="font-normal">
                {tw.review.saveMapping}
              </Label>
            </div>
            {importError ? (
              <p className="text-sm text-destructive" role="alert" data-testid="import-error">
                {importError}
              </p>
            ) : null}
            <div>
              <Button type="button" variant="ghost" onClick={() => setStep('accounts')} disabled={post.isPending}>
                {tw.back}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {step === 'done' && outcome ? (
        <Card data-testid="import-done">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400" aria-hidden />
              {tw.done.title}
            </CardTitle>
            <CardDescription>{fill(tw.done.imported, { count: outcome.imports.length })}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {outcome.duplicates.length > 0 ? (
              <div className="space-y-1">
                <p className="text-sm font-medium">{fill(tw.done.duplicates, { count: outcome.duplicates.length })}</p>
                <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
                  {outcome.duplicates.map((item) => (
                    <li key={item.importId}>{fill(tw.done.duplicateRow, { date: formatDate(item.payDate), status: item.status })}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {outcome.failed.length > 0 ? (
              <div className="space-y-1">
                <p className="text-sm font-medium text-destructive">{tw.done.failedTitle}</p>
                <ul className="list-disc space-y-0.5 pl-5 text-sm">
                  {outcome.failed.map((item) => (
                    <li key={`${item.payDate}-${item.error}`}>
                      {formatDate(item.payDate)}: {item.error}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button asChild>
                <Link to="/weldbooks/payroll">{tw.done.viewImports}</Link>
              </Button>
              <Button type="button" variant="outline" onClick={reset}>
                {tw.done.importAnother}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
