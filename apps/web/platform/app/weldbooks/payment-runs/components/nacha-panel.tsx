import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { toast } from 'sonner';
import { Download, Loader2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useI18n } from '@/lib/i18n/provider';
import { downloadBlob } from '@/lib/weldbooks/download';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useCompletePaymentRun, useNachaFile } from '@/hooks/queries/use-weldbooks-payment-runs-queries';
import type { FileIssue, NachaSummary, PaymentRunDetail } from '@/lib/api/domains/weldbooks-payment-runs';
import { changedVendorsOf, describeRunError, errorCodeOf, fileIssuesOf, missingSettingsOf } from '../run-errors';
import { MissingSettings } from './missing-settings';

interface NachaPanelProps {
  run: PaymentRunDetail;
  canManage: boolean;
}

/** The ACH file of an approved run: make it, download it, and close the run once the bank has taken it. */
export function NachaPanel({ run, canManage }: Readonly<NachaPanelProps>) {
  const { t } = useI18n();
  const tp = t.weldbooksUs.payments;
  const tn = tp.detail.nacha;
  const { formatMoney, formatDate, formatDateTime } = useWeldbooksFormat();

  const nacha = useNachaFile();
  const complete = useCompletePaymentRun();
  const [summary, setSummary] = useState<NachaSummary | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [confirmComplete, setConfirmComplete] = useState(false);

  if (run.method !== 'ach' || (run.status !== 'approved' && run.status !== 'exported' && run.status !== 'completed')) return null;

  const download = () => {
    setError(null);
    nacha.mutate(run.id, {
      onSuccess: ({ file }) => {
        downloadBlob(new Blob([file.content], { type: 'text/plain;charset=utf-8' }), file.fileName);
        // Only the summary stays on screen: the file itself holds vendor account numbers.
        setSummary(file.summary);
        // The mutation would keep the file in memory while this panel is open.
        nacha.reset();
        toast.success(tn.downloaded);
      },
      onError: (err) => setError(err),
    });
  };

  const finish = async () => {
    try {
      await complete.mutateAsync(run.id);
      toast.success(tn.completed);
      setConfirmComplete(false);
    } catch (err) {
      setConfirmComplete(false);
      toast.error(tn.completeFailed, { description: describeRunError(err, tp.errors, tp.errors.generic) });
    }
  };

  // The entries are what the vendors are paid, net of backup withholding: say how much stayed in the bank account.
  const withheldTotal = (summary?.payments ?? []).reduce(
    (sum, payment) => Math.round((sum + Number.parseFloat(payment.backupWithholdingAmount ?? '0')) * 100) / 100,
    0,
  );

  const code = errorCodeOf(error);
  const issues = fileIssuesOf(error);
  const missing = missingSettingsOf(error);
  const changedVendors = changedVendorsOf(error);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{tn.title}</CardTitle>
        <CardDescription>
          {run.status === 'approved' ? tn.approvedHint : run.status === 'exported' ? tn.exportedHint : tn.completedHint}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {run.fileName && run.fileGeneratedAt ? (
          <p className="text-sm text-muted-foreground">
            {tn.lastFile.replace('{name}', run.fileName).replace('{date}', formatDateTime(run.fileGeneratedAt))}
          </p>
        ) : null}

        {canManage && run.status !== 'completed' ? (
          <div className="flex flex-wrap gap-2">
            <Button onClick={download} disabled={nacha.isPending}>
              {nacha.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
              {run.status === 'approved' ? tn.download : tn.downloadAgain}
            </Button>
            {run.status === 'exported' ? (
              <Button variant="outline" onClick={() => setConfirmComplete(true)} disabled={complete.isPending}>
                {tn.markCompleted}
              </Button>
            ) : null}
          </div>
        ) : null}
        {!canManage && run.status !== 'completed' ? <p className="text-sm text-muted-foreground">{tn.needsManage}</p> : null}

        {error ? (
          <div className="space-y-3">
            {code === 'ACH_SETTINGS_INCOMPLETE' ? (
              <MissingSettings missing={missing} bankAccountId={run.bankAccountId} title={tn.settingsIncomplete} canEdit={canManage} />
            ) : (
              <Alert variant="destructive">
                <AlertTitle>{tn.failed}</AlertTitle>
                <AlertDescription>
                  <p>{describeRunError(error, tp.errors, tp.errors.generic)}</p>
                  {code === 'BANK_DETAILS_CHANGED' && changedVendors.length > 0 ? (
                    <ul className="mt-1 list-disc pl-4">
                      {changedVendors.map((vendor) => (
                        <li key={vendor.partyId}>{vendor.name ?? vendor.partyId}</li>
                      ))}
                    </ul>
                  ) : null}
                  {code === 'BANK_DETAILS_CHANGED' ? (
                    <Link to="/weldbooks/suppliers" className="mt-1 inline-block font-medium underline underline-offset-2">
                      {tp.holds.fixVendor}
                    </Link>
                  ) : null}
                  <IssueList issues={issues.errors} />
                </AlertDescription>
              </Alert>
            )}
            {issues.warnings.length > 0 ? (
              <Alert>
                <AlertTitle>{tn.warnings}</AlertTitle>
                <AlertDescription>
                  <IssueList issues={issues.warnings} />
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
        ) : null}

        {summary ? (
          <div className="space-y-3">
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <dt className="text-muted-foreground">{tn.summary.fileName}</dt>
                <dd className="break-all font-medium">{summary.fileName}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{tn.summary.effectiveDate}</dt>
                <dd className="font-medium">{formatDate(summary.effectiveEntryDate)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{tn.summary.payments}</dt>
                <dd className="font-medium tabular-nums">{summary.paymentCount}</dd>
              </div>
              {summary.prenoteCount > 0 ? (
                <div>
                  <dt className="text-muted-foreground">{tn.summary.prenotesLabel}</dt>
                  <dd className="font-medium tabular-nums">{summary.prenoteCount}</dd>
                </div>
              ) : null}
              <div>
                <dt className="text-muted-foreground">{tn.summary.totalCredit}</dt>
                <dd className="font-medium tabular-nums">{formatMoney(summary.totalCredit)}</dd>
              </div>
              {withheldTotal > 0 ? (
                <div>
                  <dt className="text-muted-foreground">{tn.summary.withheld}</dt>
                  <dd className="font-medium tabular-nums">{formatMoney(withheldTotal)}</dd>
                </div>
              ) : null}
              {summary.balanced ? (
                <div>
                  <dt className="text-muted-foreground">{tn.summary.totalDebit}</dt>
                  <dd className="font-medium tabular-nums">{formatMoney(summary.totalDebit)}</dd>
                </div>
              ) : null}
              <div>
                <dt className="text-muted-foreground">{tn.summary.company}</dt>
                <dd className="font-medium">{summary.originator.companyName}</dd>
              </div>
              {summary.sameDay ? (
                <div>
                  <dt className="text-muted-foreground">{tn.summary.sameDay}</dt>
                  <dd className="font-medium">{tp.sameDay}</dd>
                </div>
              ) : null}
            </dl>
            {summary.warnings.length > 0 ? (
              <Alert>
                <AlertTitle>{tn.warnings}</AlertTitle>
                <AlertDescription>
                  <IssueList issues={summary.warnings} />
                </AlertDescription>
              </Alert>
            ) : null}
            <p className="text-sm text-muted-foreground">{tn.uploadHint}</p>
          </div>
        ) : null}
      </CardContent>

      <ConfirmDialog
        open={confirmComplete}
        onOpenChange={setConfirmComplete}
        title={tn.completeTitle}
        description={tn.completeDescription}
        confirmLabel={tn.markCompleted}
        cancelLabel={tp.common.cancel}
        onConfirm={finish}
      />
    </Card>
  );
}

/** Issues of a failed file, one per line. */
export function IssueList({ issues }: Readonly<{ issues: readonly FileIssue[] }>) {
  if (issues.length === 0) return null;
  return (
    <ul className="mt-1 list-disc space-y-0.5 pl-4">
      {issues.map((issue, index) => (
        <li key={`${issue.code}-${issue.paymentId ?? issue.checkNumber ?? index}`}>{issue.message}</li>
      ))}
    </ul>
  );
}
