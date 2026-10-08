import { useRef, useState } from 'react';
import { Download, Loader2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useApplyTinMatchingResults, useTinMatchingFile } from '@/hooks/queries/use-weldbooks-1099-queries';
import type { TinMatchingFileResult, TinMatchingResultsSummary } from '@/lib/api/domains/weldbooks-1099';
import { useI18n } from '@/lib/i18n/provider';
import { downloadBlob } from '@/lib/weldbooks/download';
import { BackupWithholdingButton } from './backup-withholding-button';

/** The IRS TIN matching results file is plain text; anything bigger than this is not one. */
const MAX_RESULTS_BYTES = 5_000_000;

function TinMatchingFileCard() {
  const { t } = useI18n();
  const tm = t.weldbooksUs.form1099.tinMatching;
  const { can } = usePermissions();
  const file = useTinMatchingFile();
  const [includeMatched, setIncludeMatched] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // The files hold full TINs: they live in this state until the user is done and are never cached.
  const [result, setResult] = useState<TinMatchingFileResult | null>(null);

  const allowed = can('taxes:file') && can('tax_ids:reveal');

  const generate = async () => {
    try {
      setResult(await file.run({ all: includeMatched }));
      setConfirmOpen(false);
    } catch (err) {
      setConfirmOpen(false);
      toast.error(tm.fileFailed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  const download = (name: string, content: string) => downloadBlob(new Blob([content], { type: 'text/plain;charset=utf-8' }), name);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{tm.step1Title}</CardTitle>
        <CardDescription>{tm.step1Description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {allowed ? (
          <>
            <label className="flex items-center gap-2 text-sm" htmlFor="tin-include-matched">
              <Checkbox
                id="tin-include-matched"
                checked={includeMatched}
                onCheckedChange={(checked) => setIncludeMatched(checked === true)}
              />
              {tm.includeMatched}
            </label>
            <Button type="button" onClick={() => setConfirmOpen(true)} disabled={file.isPending}>
              {file.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : <Download className="mr-1 h-4 w-4" aria-hidden />}
              {tm.generate}
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{tm.needsPermission}</p>
        )}

        {result ? (
          <div className="space-y-3 rounded-md border p-3" data-testid="tin-file-result">
            <p className="text-sm font-medium">{tm.fileReady.replace('{n}', String(result.recordCount))}</p>
            {result.files.length === 0 ? <p className="text-sm text-muted-foreground">{tm.noRecords}</p> : null}
            <ul className="space-y-1">
              {result.files.map((f) => (
                <li key={f.filename} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span>
                    {f.filename} <span className="text-muted-foreground">({tm.records.replace('{n}', String(f.recordCount))})</span>
                  </span>
                  <Button type="button" size="sm" variant="outline" onClick={() => download(f.filename, f.content)}>
                    <Download className="mr-1 h-4 w-4" aria-hidden />
                    {tm.download}
                  </Button>
                </li>
              ))}
            </ul>
            {result.skipped.length > 0 ? (
              <div>
                <p className="text-sm font-medium">{tm.skipped}</p>
                <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                  {result.skipped.map((s) => (
                    <li key={s.partyId}>
                      {s.name ?? s.partyId}: {(tm.skipReasons as Record<string, string>)[s.reason] ?? s.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">{tm.fileContainsTins}</p>
            <Button type="button" size="sm" variant="ghost" onClick={() => setResult(null)}>
              {tm.clear}
            </Button>
          </div>
        ) : null}
      </CardContent>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={tm.confirmTitle}
        description={tm.confirmDescription}
        confirmLabel={tm.confirm}
        cancelLabel={tm.cancel}
        loading={file.isPending}
        onConfirm={generate}
      />
    </Card>
  );
}

function ResultsSummary({ summary }: Readonly<{ summary: TinMatchingResultsSummary }>) {
  const { t } = useI18n();
  const tm = t.weldbooksUs.form1099.tinMatching;
  const statuses = Object.entries(summary.byStatus);
  return (
    <div className="space-y-4" data-testid="tin-results">
      <p className="text-sm font-medium">{tm.updated.replace('{n}', String(summary.updated.length))}</p>
      {statuses.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {statuses.map(([status, count]) => (
            <li key={status}>
              <Badge variant={status === 'match' ? 'success' : 'destructive'}>
                {(t.weldbooksUs.form1099.tinMatch.status as Record<string, string>)[status] ?? status}: {count}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}

      {summary.problems.length > 0 ? (
        <Alert variant="destructive" data-testid="tin-problems">
          <AlertTitle>{tm.problemsTitle.replace('{n}', String(summary.problems.length))}</AlertTitle>
          <AlertDescription>
            <p className="mb-2">{tm.problemsHelp}</p>
            <ul className="space-y-2">
              {summary.problems.map((problem) => (
                <li key={problem.partyId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 p-2">
                  <div>
                    <p className="font-medium">
                      {problem.name ?? problem.partyId}{' '}
                      <Badge variant="destructive">
                        {(t.weldbooksUs.form1099.tinMatch.status as Record<string, string>)[problem.status] ?? problem.status}
                      </Badge>
                    </p>
                    <p className="text-xs">{problem.backupWithholding ? tm.backupAlreadyOn : tm.suggestion}</p>
                  </div>
                  {problem.backupWithholding ? null : (
                    <BackupWithholdingButton partyId={problem.partyId} vendorName={problem.name ?? problem.partyId} />
                  )}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {summary.stale.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {tm.stale.replace('{names}', summary.stale.map((s) => s.name ?? s.partyId).join(', '))}
        </p>
      ) : null}
      {summary.unknownAccounts.length > 0 ? (
        <p className="text-xs text-muted-foreground">{tm.unknown.replace('{n}', String(summary.unknownAccounts.length))}</p>
      ) : null}
      {summary.ignored.length > 0 ? (
        <p className="text-xs text-muted-foreground">{tm.ignored.replace('{n}', String(summary.ignored.length))}</p>
      ) : null}
      {summary.unreadable.length > 0 ? (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {tm.unreadable.replace('{n}', String(summary.unreadable.length))}
        </p>
      ) : null}
    </div>
  );
}

function ResultsCard() {
  const { t } = useI18n();
  const tm = t.weldbooksUs.form1099.tinMatching;
  const { can } = usePermissions();
  const apply = useApplyTinMatchingResults();
  const [text, setText] = useState('');
  const [summary, setSummary] = useState<TinMatchingResultsSummary | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const allowed = can('taxes:file');

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_RESULTS_BYTES) {
      toast.error(tm.fileTooLarge);
      return;
    }
    setText(await file.text());
    if (fileInput.current) fileInput.current.value = '';
  };

  const submit = async () => {
    try {
      setSummary(await apply.mutateAsync(text));
      setText('');
    } catch (err) {
      toast.error(tm.applyFailed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{tm.step2Title}</CardTitle>
        <CardDescription>{tm.step2Description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {allowed ? (
          <>
            <div className="space-y-2">
              <Label htmlFor="tin-results-text">{tm.resultsLabel}</Label>
              <Textarea
                id="tin-results-text"
                rows={6}
                className="font-mono text-xs"
                spellCheck={false}
                value={text}
                placeholder={tm.resultsPlaceholder}
                onChange={(event) => setText(event.target.value)}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileInput}
                type="file"
                accept=".txt,.csv,text/plain,text/csv"
                className="sr-only"
                aria-label={tm.chooseFile}
                onChange={(event) => void pickFile(event.target.files?.[0])}
              />
              <Button type="button" variant="outline" onClick={() => fileInput.current?.click()}>
                <Upload className="mr-1 h-4 w-4" aria-hidden />
                {tm.chooseFile}
              </Button>
              <Button type="button" onClick={() => void submit()} disabled={!text.trim() || apply.isPending}>
                {apply.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : null}
                {tm.apply}
              </Button>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{tm.needsPermissionResults}</p>
        )}
        {summary ? <ResultsSummary summary={summary} /> : null}
      </CardContent>
    </Card>
  );
}

/**
 * IRS TIN matching: download the upload file (full TINs, logged), take it to
 * the IRS e-Services portal, bring the answer back, and see which vendors the
 * IRS could not match.
 */
export function TinMatchingPanel() {
  const { t } = useI18n();
  const tm = t.weldbooksUs.form1099.tinMatching;
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-muted-foreground">{tm.intro}</p>
      <TinMatchingFileCard />
      <ResultsCard />
    </div>
  );
}
