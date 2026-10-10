/**
 * My HR → Payroll: the employee's payslips and annual statements, the payroll
 * details WeldSuite holds (masked, editable), what is still missing, and the
 * tax forms to sign (loonheffingskorting in the Netherlands; W-4 and the work
 * state's certificate in the United States).
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { Download, FilePenLine, Pencil, ShieldAlert } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrMyPayrollDetails, HrTaxElectionKind } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import {
  useDownloadMyAnnualStatementPdf,
  useDownloadMyPayslipPdf,
  useMyAnnualStatements,
  useMyPayrollDetails,
  useMyPayslips,
  useSignMyTaxElection,
  useUpdateMyPayrollDetails,
} from '@/hooks/queries/use-weldhr-payroll-queries';
import { EmptyText, SectionCard } from '../../components/page-kit';
import { ErrorBanner, errorMessage, formatDate } from '../../components/shared';
import { PaymentDetailsForm } from '../../payroll/components/payment-details-form';
import { PaymentDetailsView } from '../../payroll/components/payment-details-view';
import { InfoLine } from '../../payroll/components/payroll-ui';
import { TaxElectionDialog, type TaxElectionTarget } from '../../payroll/components/tax-election-dialog';
import { electionSummary } from '../../payroll/lib/election-summary';
import { formatDecimal } from '../../payroll/lib/format';
import { usePayrollLabels } from '../../payroll/lib/use-payroll-labels';
import { TabLoading } from './shared';

/** The election forms the employee still has to sign. */
export function unsignedElections(details: HrMyPayrollDetails): Array<{ kind: HrTaxElectionKind; state: string | null }> {
  return details.requiredElections.filter(
    (required) => !details.elections.some((election) => election.kind === required.kind && (election.state ?? null) === (required.state ?? null)),
  );
}

export function MyPayrollTab({ employeeName }: Readonly<{ employeeName: string }>) {
  const t = useTranslations();
  const labels = usePayrollLabels();
  const { data: details, isLoading, error } = useMyPayrollDetails();
  const { data: payslips, error: payslipsError } = useMyPayslips();
  const { data: statements } = useMyAnnualStatements();
  const payslipPdf = useDownloadMyPayslipPdf();
  const statementPdf = useDownloadMyAnnualStatementPdf();

  const [editing, setEditing] = useState(false);
  const [detailsFailure, setDetailsFailure] = useState<string | null>(null);
  const [signing, setSigning] = useState<TaxElectionTarget | null>(null);
  const updateDetails = useUpdateMyPayrollDetails();
  const signElection = useSignMyTaxElection();

  if (isLoading) return <TabLoading />;
  if (!details) return <ErrorBanner error={errorMessage(error, t('weldhr.payroll.me.loadFailed'))} />;

  const country = details.country;
  const unsigned = unsignedElections(details);
  // Every form that is required or already signed, once.
  const forms: TaxElectionTarget[] = [...details.requiredElections];
  for (const election of details.elections) {
    if (!forms.some((candidate) => candidate.kind === election.kind && (candidate.state ?? null) === (election.state ?? null))) {
      forms.push({ kind: election.kind, state: election.state });
    }
  }
  const stateOption = (state: string, option: string) => labels.stateOption(state, 'filingStatus', option);

  return (
    <div className="space-y-4">
      {(details.missing.length > 0 || unsigned.length > 0) && (
        <SectionCard title={t('weldhr.payroll.me.todo.title')}>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t('weldhr.payroll.me.todo.description')}</p>
            <ul className="list-inside list-disc space-y-1 text-sm">
              {details.missing.map((field) => (
                <li key={field}>{labels.missingField(field)}</li>
              ))}
              {unsigned.map((form) => (
                <li key={`${form.kind}-${form.state ?? ''}`}>{t('weldhr.payroll.me.todo.sign', { form: t(`weldhr.payroll.elections.titles.${form.kind}`, { state: form.state ?? '' }) })}</li>
              ))}
            </ul>
          </div>
        </SectionCard>
      )}

      <SectionCard title={t('weldhr.payroll.me.payslips.title')} contentClassName="p-0">
        <ErrorBanner error={payslipsError ? errorMessage(payslipsError, t('weldhr.payroll.me.payslips.loadFailed')) : null} />
        {payslips && payslips.length === 0 && <EmptyText>{t('weldhr.payroll.me.payslips.empty')}</EmptyText>}
        {payslips && payslips.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('weldhr.payroll.common.period')}</TableHead>
                <TableHead>{t('weldhr.payroll.common.payDate')}</TableHead>
                <TableHead>{t('weldhr.payroll.common.employer')}</TableHead>
                <TableHead className="text-right">{t('weldhr.payroll.common.gross')}</TableHead>
                <TableHead className="text-right">{t('weldhr.payroll.common.net')}</TableHead>
                <TableHead className="w-px" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {payslips.map((payslip) => (
                <TableRow key={payslip.id}>
                  <TableCell className="whitespace-nowrap">
                    <span className={payslip.viewedAt ? undefined : 'font-medium'}>
                      {formatDate(payslip.periodStart)} – {formatDate(payslip.periodEnd)}
                    </span>
                    {!payslip.viewedAt && <Badge className="ml-2" variant="outline">{t('weldhr.payroll.me.payslips.new')}</Badge>}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{formatDate(payslip.payDate)}</TableCell>
                  <TableCell className="text-muted-foreground">{payslip.employerName}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatDecimal(payslip.grossPay, payslip.currency)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{formatDecimal(payslip.netPay, payslip.currency)}</TableCell>
                  <TableCell>
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs"
                        disabled={payslipPdf.isPending}
                        onClick={() =>
                          payslipPdf.mutate({ id: payslip.id, number: payslip.number }, { onError: (err) => toast.error(errorMessage(err, t('weldhr.payroll.payslip.pdfFailed'))) })
                        }
                      >
                        <Download className="mr-1 h-3.5 w-3.5" />
                        {t('weldhr.payroll.me.payslips.download')}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      {statements && statements.length > 0 && (
        <SectionCard title={t('weldhr.payroll.me.statements.title')}>
          <ul className="flex flex-wrap gap-2">
            {statements.map((statement) => (
              <li key={`${statement.employerId}-${statement.year}`}>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={statementPdf.isPending}
                  onClick={() =>
                    statementPdf.mutate(
                      { year: statement.year, employerId: statement.employerId },
                      { onError: (err) => toast.error(errorMessage(err, t('weldhr.payroll.employee.payslips.statementFailed'))) },
                    )
                  }
                >
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  {t(`weldhr.payroll.annualStatement.${statement.kind}`, { year: statement.year })}
                  <span className="ml-1.5 text-muted-foreground">· {statement.employerName}</span>
                </Button>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {country && (
        <>
          <SectionCard
            title={t('weldhr.payroll.me.details.title')}
            action={
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                <Pencil className="mr-1.5 h-4 w-4" />
                {t('weldhr.common.edit')}
              </Button>
            }
          >
            <div className="space-y-4">
              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {t('weldhr.payroll.me.details.notice', { employer: details.employerName ?? '' })}
              </p>
              <PaymentDetailsView country={country} details={details.paymentDetails} />
            </div>
          </SectionCard>

          <SectionCard title={t('weldhr.payroll.me.forms.title')} contentClassName="p-0">
            {forms.length === 0 ? (
              <EmptyText>{t('weldhr.payroll.me.forms.empty')}</EmptyText>
            ) : (
              <ul className="divide-y">
                {forms.map((form) => {
                  const signed = details.elections.find((election) => election.kind === form.kind && (election.state ?? null) === (form.state ?? null));
                  return (
                    <li key={`${form.kind}-${form.state ?? ''}`} className="flex flex-wrap items-center justify-between gap-3 px-6 py-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{t(`weldhr.payroll.elections.titles.${form.kind}`, { state: form.state ?? '' })}</p>
                        <p className="text-xs text-muted-foreground">
                          {signed
                            ? `${electionSummary(signed, t, stateOption)} · ${t('weldhr.payroll.me.forms.signedOn', { date: formatDate(signed.signedAt ?? signed.effectiveFrom) })}`
                            : t('weldhr.payroll.me.forms.notSigned')}
                        </p>
                      </div>
                      <Button size="sm" variant={signed ? 'outline' : 'default'} onClick={() => setSigning(form)}>
                        <FilePenLine className="mr-1.5 h-4 w-4" />
                        {signed ? t('weldhr.payroll.me.forms.update') : t('weldhr.payroll.me.forms.sign')}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="border-t px-6 py-3">
              <InfoLine>{t('weldhr.payroll.me.forms.hint')}</InfoLine>
            </div>
          </SectionCard>
        </>
      )}

      {editing && country && (
        <Dialog open onOpenChange={(open) => !open && !updateDetails.isPending && setEditing(false)}>
          <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>{t('weldhr.payroll.details.editTitle')}</DialogTitle>
              <DialogDescription>{t('weldhr.payroll.details.editDescriptionSelf')}</DialogDescription>
            </DialogHeader>
            <PaymentDetailsForm
              country={country}
              details={details.paymentDetails}
              isHr={false}
              saving={updateDetails.isPending}
              failure={detailsFailure}
              onCancel={() => setEditing(false)}
              onSubmit={async (values) => {
                setDetailsFailure(null);
                try {
                  await updateDetails.mutateAsync(values);
                  toast.success(t('weldhr.payroll.details.saved'));
                  setEditing(false);
                } catch (err) {
                  setDetailsFailure(errorMessage(err, t('weldhr.payroll.details.saveFailed')));
                }
              }}
            />
          </DialogContent>
        </Dialog>
      )}

      {signing && (
        <TaxElectionDialog
          target={signing}
          mode="self"
          defaultName={employeeName}
          onSubmit={async (election) => {
            await signElection.mutateAsync(election);
            toast.success(t('weldhr.payroll.me.forms.signed'));
            setSigning(null);
          }}
          onClose={() => setSigning(null)}
        />
      )}
    </div>
  );
}
