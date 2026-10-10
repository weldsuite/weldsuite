/**
 * WeldHR Payroll — one pay run. Employes' flow: check the inputs, calculate,
 * approve in one click, download the payment file, mark as paid. Errors block
 * approval, warnings are listed. Actions follow the run status and the
 * caller's payroll permissions (prepare / approve / read).
 */

import { useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { toast } from 'sonner';
import { Banknote, Calculator, CheckCheck, Download, FileSpreadsheet, History, Loader2, Pencil, RefreshCw, RotateCcw, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrPayRunDetail } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageLoader } from '@/components/page-loader';
import {
  useApproveHrPayRun,
  useCalculateHrPayRun,
  useCancelHrPayRun,
  useCollectHrPayRunInputs,
  useCreateHrPayRun,
  useDownloadHrPayRunPaymentFile,
  useDownloadHrPayRunReport,
  useHrPayRun,
  usePostHrPayRunJournal,
  useSetHrPayRunEmployee,
} from '@/hooks/queries/use-weldhr-payroll-queries';
import { DetailHeader, DetailPage, KpiCard, KpiGrid, SectionCard, useHrBreadcrumbs } from '../../../components/page-kit';
import { ErrorBanner, errorMessage, formatDate, formatDateTime } from '../../../components/shared';
import { EditRunDialog, MarkPaidDialog } from '../../components/run-dialogs';
import { RunEmployeesTable } from '../../components/run-employees-table';
import { RunInputsSheet } from '../../components/run-inputs-sheet';
import { RunStepper } from '../../components/run-stepper';
import { PayslipSheet } from '../../components/payslip-sheet';
import { InfoLine, IssueList, PayrollGate, RunStatusBadge } from '../../components/payroll-ui';
import { formatCents, periodRange } from '../../lib/format';

export default function WeldHrPayrollRunPage() {
  return (
    <PayrollGate>
      <RunDetail />
    </PayrollGate>
  );
}

type DialogKind = 'edit' | 'approve' | 'paid' | 'cancel' | 'correction' | null;

function RunDetail() {
  const t = useTranslations();
  const { runId } = useParams({ from: '/weldhr/payroll/runs/$runId/' });
  const navigate = useNavigate();
  const { can } = usePermissions();
  const canPrepare = can('payroll:prepare');
  const canApproveRuns = can('payroll:approve');

  const { data: run, isLoading, error } = useHrPayRun(runId);
  useHrBreadcrumbs(
    { label: t('weldhr.payroll.title'), href: '/weldhr/payroll' },
    { label: t('weldhr.payroll.runs.title'), href: '/weldhr/payroll/runs' },
    run ? { label: periodRange(run.periodStart, run.periodEnd) } : null,
  );

  const collect = useCollectHrPayRunInputs();
  const calculate = useCalculateHrPayRun();
  const approve = useApproveHrPayRun();
  const cancel = useCancelHrPayRun();
  const setEmployee = useSetHrPayRunEmployee();
  const postJournal = usePostHrPayRunJournal();
  const createRun = useCreateHrPayRun();
  const paymentFile = useDownloadHrPayRunPaymentFile();
  const report = useDownloadHrPayRunReport();

  const [dialog, setDialog] = useState<DialogKind>(null);
  const [inputsFor, setInputsFor] = useState<{ employeeId: string; name: string } | null>(null);
  const [payslipId, setPayslipId] = useState<string | null>(null);

  if (isLoading) return <PageLoader fullScreen={false} />;
  if (!run) {
    return (
      <DetailPage>
        <ErrorBanner error={errorMessage(error, t('weldhr.payroll.run.notFound'))} />
      </DetailPage>
    );
  }

  const editable = (run.status === 'draft' || run.status === 'calculated') && canPrepare;
  const hasTotals = run.totals !== null;
  const nameOf = (employeeId: string) => run.employees.find((employee) => employee.employeeId === employeeId)?.displayName;

  // Why the Approve button is off, if it is.
  let approveBlocked: string | null = null;
  if (run.status === 'calculated') {
    if (run.errorCount > 0) approveBlocked = t('weldhr.payroll.run.approveBlocked.errors', { count: run.errorCount });
    else if (!run.canApprove) approveBlocked = t('weldhr.payroll.run.approveBlocked.fourEyes');
  }

  async function perform<T>(action: () => Promise<T>, success: string | null, failure: string) {
    try {
      await action();
      if (success) toast.success(success);
    } catch (err) {
      toast.error(errorMessage(err, failure));
    }
  }

  function download(kind: 'payment' | 'report', current: HrPayRunDetail) {
    const onError = (err: Error) => toast.error(errorMessage(err, t('weldhr.payroll.run.downloadFailed')));
    if (kind === 'payment') paymentFile.mutate({ id: current.id, format: current.paymentFile.format }, { onError });
    else report.mutate(current.id, { onError });
  }

  const busy = collect.isPending || calculate.isPending || approve.isPending || cancel.isPending;

  return (
    <DetailPage>
      <DetailHeader
        title={t('weldhr.payroll.run.title', { period: periodRange(run.periodStart, run.periodEnd) })}
        badges={<RunStatusBadge status={run.status} />}
        subtitle={
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{run.employerName}</span>
            <span>·</span>
            <span>{t(`weldhr.payroll.country.${run.country}`)}</span>
            {run.kind !== 'regular' && (
              <>
                <span>·</span>
                <span>{t(`weldhr.payroll.runKind.${run.kind}`)}</span>
              </>
            )}
            <span>·</span>
            <span>{t('weldhr.payroll.run.payDateLine', { date: formatDate(run.payDate) })}</span>
            {editable && (
              <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs" onClick={() => setDialog('edit')}>
                <Pencil className="mr-1 h-3 w-3" />
                {t('weldhr.payroll.run.change')}
              </Button>
            )}
          </div>
        }
        actions={
          <>
            {editable && run.kind !== 'correction' && (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void perform(() => collect.mutateAsync(run.id), t('weldhr.payroll.run.collected'), t('weldhr.payroll.run.collectFailed'))}>
                {collect.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}
                {t('weldhr.payroll.run.collect')}
              </Button>
            )}
            {editable && (
              <Button
                variant={run.status === 'draft' ? 'default' : 'outline'}
                size="sm"
                disabled={busy}
                onClick={() => void perform(() => calculate.mutateAsync(run.id), t('weldhr.payroll.run.calculated'), t('weldhr.payroll.run.calculateFailed'))}
              >
                {calculate.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Calculator className="mr-1.5 h-4 w-4" />}
                {run.status === 'draft' ? t('weldhr.payroll.run.calculate') : t('weldhr.payroll.run.recalculate')}
              </Button>
            )}
            {run.status === 'calculated' && canApproveRuns && (
              <Button size="sm" disabled={busy || approveBlocked !== null} onClick={() => setDialog('approve')}>
                <CheckCheck className="mr-1.5 h-4 w-4" />
                {t('weldhr.payroll.run.approve')}
              </Button>
            )}
            {(run.status === 'approved' || run.status === 'paid') && canApproveRuns && run.paymentFile.available && (
              <Button variant="outline" size="sm" disabled={paymentFile.isPending} onClick={() => download('payment', run)}>
                {paymentFile.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Download className="mr-1.5 h-4 w-4" />}
                {run.paymentFile.format === 'sepa' ? t('weldhr.payroll.run.downloadSepa') : t('weldhr.payroll.run.downloadNacha')}
              </Button>
            )}
            {run.status === 'approved' && canApproveRuns && (
              <Button size="sm" onClick={() => setDialog('paid')}>
                <Banknote className="mr-1.5 h-4 w-4" />
                {t('weldhr.payroll.run.markPaid')}
              </Button>
            )}
            {hasTotals && run.status !== 'cancelled' && (
              <Button variant="outline" size="sm" disabled={report.isPending} onClick={() => download('report', run)}>
                {report.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <FileSpreadsheet className="mr-1.5 h-4 w-4" />}
                {t('weldhr.payroll.run.downloadReport')}
              </Button>
            )}
            {(run.status === 'approved' || run.status === 'paid') && canPrepare && (
              <Button variant="ghost" size="sm" onClick={() => setDialog('correction')}>
                <History className="mr-1.5 h-4 w-4" />
                {t('weldhr.payroll.run.correction')}
              </Button>
            )}
            {editable && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDialog('cancel')}>
                <X className="mr-1.5 h-4 w-4" />
                {t('weldhr.payroll.run.cancel')}
              </Button>
            )}
          </>
        }
      />

      <RunStepper status={run.status} />

      {run.status === 'calculated' && approveBlocked && <InfoLine>{approveBlocked}</InfoLine>}
      {run.status === 'draft' && <InfoLine>{t('weldhr.payroll.run.draftHint')}</InfoLine>}
      {run.status === 'approved' && <InfoLine>{t('weldhr.payroll.run.approvedHint')}</InfoLine>}

      <JournalNotice run={run} canRetry={canApproveRuns} retrying={postJournal.isPending} onRetry={() => void perform(() => postJournal.mutateAsync(run.id), t('weldhr.payroll.run.journalPosted'), t('weldhr.payroll.run.journalRetryFailed'))} />

      {run.issues.length > 0 && (
        <SectionCard title={t('weldhr.payroll.issuesPanel.title')}>
          <p className="mb-3 text-sm text-muted-foreground">
            {t('weldhr.payroll.issuesPanel.summary', { errors: run.errorCount, warnings: run.warningCount })}
          </p>
          <IssueList issues={run.issues} nameOf={nameOf} currency={run.currency} />
        </SectionCard>
      )}

      {run.totals ? (
        <KpiGrid>
          <KpiCard label={t('weldhr.payroll.common.gross')} value={formatCents(run.totals.grossCents, run.currency)} />
          <KpiCard label={t('weldhr.payroll.common.net')} value={formatCents(run.totals.netCents, run.currency)} tone="success" />
          <KpiCard
            label={t('weldhr.payroll.common.employerCost')}
            value={formatCents(run.totals.employerCostCents, run.currency)}
            hint={t('weldhr.payroll.run.employerCostHint', { taxes: formatCents(run.totals.employerTaxesCents, run.currency) })}
          />
          <KpiCard
            label={t('weldhr.payroll.common.taxes')}
            value={formatCents(run.totals.employeeTaxesCents, run.currency)}
            hint={t('weldhr.payroll.run.taxesHint', {
              deductions: formatCents(run.totals.employeeDeductionsCents, run.currency),
              reimbursements: formatCents(run.totals.reimbursementsCents, run.currency),
            })}
          />
        </KpiGrid>
      ) : (
        <InfoLine>{t('weldhr.payroll.run.noTotals')}</InfoLine>
      )}

      <SectionCard title={t('weldhr.payroll.run.employees.title', { count: run.employeeCount })} contentClassName="p-0">
        <RunEmployeesTable
          run={run}
          canExclude={editable}
          togglingId={setEmployee.isPending ? (setEmployee.variables?.employeeId ?? null) : null}
          onToggle={(employeeId, excluded) =>
            void perform(() => setEmployee.mutateAsync({ id: run.id, employeeId, excluded }), null, t('weldhr.payroll.run.employees.toggleFailed'))
          }
          onOpenInputs={(employeeId, name) => setInputsFor({ employeeId, name })}
          onOpenPayslip={setPayslipId}
        />
      </SectionCard>

      <RunFootnote run={run} />

      {dialog === 'edit' && <EditRunDialog run={run} onClose={() => setDialog(null)} />}
      {dialog === 'paid' && <MarkPaidDialog run={run} onClose={() => setDialog(null)} />}
      {inputsFor && (
        <RunInputsSheet run={run} employeeId={inputsFor.employeeId} employeeName={inputsFor.name} editable={editable} onClose={() => setInputsFor(null)} />
      )}
      {payslipId && <PayslipSheet payslipId={payslipId} onClose={() => setPayslipId(null)} />}

      <ConfirmDialog
        open={dialog === 'approve'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={t('weldhr.payroll.run.approveConfirm.title')}
        description={t('weldhr.payroll.run.approveConfirm.description', {
          count: run.employeeCount,
          net: formatCents(run.totals?.netCents, run.currency),
        })}
        confirmLabel={t('weldhr.payroll.run.approve')}
        cancelLabel={t('weldhr.common.cancel')}
        onConfirm={async () => {
          await perform(() => approve.mutateAsync(run.id), t('weldhr.payroll.run.approved'), t('weldhr.payroll.run.approveFailed'));
          setDialog(null);
        }}
      />
      <ConfirmDialog
        open={dialog === 'cancel'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={t('weldhr.payroll.run.cancelConfirm.title')}
        description={t('weldhr.payroll.run.cancelConfirm.description')}
        variant="destructive"
        confirmLabel={t('weldhr.payroll.run.cancelConfirm.confirm')}
        cancelLabel={t('weldhr.payroll.run.cancelConfirm.keep')}
        onConfirm={async () => {
          await perform(() => cancel.mutateAsync(run.id), t('weldhr.payroll.run.cancelled'), t('weldhr.payroll.run.cancelFailed'));
          setDialog(null);
        }}
      />
      <ConfirmDialog
        open={dialog === 'correction'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={t('weldhr.payroll.run.correctionConfirm.title')}
        description={t('weldhr.payroll.run.correctionConfirm.description')}
        confirmLabel={t('weldhr.payroll.run.correctionConfirm.confirm')}
        cancelLabel={t('weldhr.common.cancel')}
        onConfirm={async () => {
          try {
            const created = await createRun.mutateAsync({ employerId: run.employerId, kind: 'correction', correctsRunId: run.id });
            setDialog(null);
            void navigate({ to: '/weldhr/payroll/runs/$runId', params: { runId: created.data.id } });
          } catch (err) {
            toast.error(errorMessage(err, t('weldhr.payroll.runs.startFailed')));
          }
        }}
      />
    </DetailPage>
  );
}

/** The WeldBooks journal of an approved run: failed shows the error and a retry, the rest is a quiet line. */
function JournalNotice({
  run,
  canRetry,
  retrying,
  onRetry,
}: Readonly<{ run: HrPayRunDetail; canRetry: boolean; retrying: boolean; onRetry: () => void }>) {
  const t = useTranslations();
  if (run.status !== 'approved' && run.status !== 'paid') return null;

  if (run.journalStatus === 'failed') {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        <div className="min-w-0">
          <p className="font-medium">{t('weldhr.payroll.run.journalFailed')}</p>
          {run.journalError && <p className="break-words text-xs">{run.journalError}</p>}
        </div>
        {canRetry && (
          <Button size="sm" variant="outline" disabled={retrying} onClick={onRetry}>
            {retrying ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-1.5 h-4 w-4" />}
            {t('weldhr.payroll.run.journalRetry')}
          </Button>
        )}
      </div>
    );
  }
  return <InfoLine>{t(`weldhr.payroll.journalStatus.${run.journalStatus}`)}</InfoLine>;
}

/** Who prepared, approved and paid the run, and when. */
function RunFootnote({ run }: Readonly<{ run: HrPayRunDetail }>) {
  const t = useTranslations();
  const events = [
    run.calculatedAt && t('weldhr.payroll.run.history.calculated', { who: run.calculatedByName ?? '—', when: formatDateTime(run.calculatedAt) }),
    run.approvedAt && t('weldhr.payroll.run.history.approved', { who: run.approvedByName ?? '—', when: formatDateTime(run.approvedAt) }),
    run.paidAt && t('weldhr.payroll.run.history.paid', { when: formatDateTime(run.paidAt) }),
  ].filter((line): line is string => Boolean(line));

  if (events.length === 0 && !run.notes && !run.correctsRunId) return null;
  return (
    <SectionCard title={t('weldhr.payroll.run.history.title')}>
      <div className="space-y-1.5 text-sm text-muted-foreground">
        {events.map((line) => (
          <p key={line}>{line}</p>
        ))}
        {run.correctsRunId && (
          <p>
            <Link to="/weldhr/payroll/runs/$runId" params={{ runId: run.correctsRunId }} className="underline">
              {t('weldhr.payroll.run.history.corrects')}
            </Link>
          </p>
        )}
        {run.notes && <p className="whitespace-pre-wrap text-foreground">{run.notes}</p>}
      </div>
    </SectionCard>
  );
}
