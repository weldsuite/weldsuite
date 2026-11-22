/**
 * One annual report (KvK jaarrekening): readiness, the balance sheet, the
 * details the KvK requires and the filing actions. Editable while it is a
 * draft or was rejected; locked once it is sent, accepted or filed.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2, Download, EllipsisVertical, RefreshCw, Send, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { FieldGrid } from '@weldsuite/ui/components/field-grid';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { DetailHeader, DetailPage } from '@weldsuite/ui/components/page-layout';
import { JurisdictionGate } from '@/components/accounting/jurisdiction-gate';
import { FilingStatusSummary, PreprodBadge } from '@/components/accounting/digipoort-filing';
import { MarkVatFiledDialog } from '@/components/objects/vat-return/mark-vat-filed-dialog';
import {
  useAnnualReport,
  useAnnualReportFilingStatus,
  useDeleteAnnualReport,
  useFileAnnualReport,
  useMarkAnnualReportFiled,
  useRecalculateAnnualReport,
  useUpdateAnnualReport,
} from '@/hooks/queries/use-annual-report-queries';
import { accountingApi } from '@/lib/api/domains/weldbooks';
import { isFeatureAvailable } from '@/lib/edition';
import { useI18n } from '@/lib/i18n/provider';
import { downloadBlob } from '@/lib/weldbooks/download';
import {
  isAnnualReportEditable,
  type AnnualReport,
} from '@/lib/weldbooks/annual-report-model';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { AnnualReportStatusChip } from '../annual-report-status';
import {
  annualReportFormSchema,
  formValuesToPatch,
  reportToFormValues,
  type AnnualReportFormValues,
} from '../annual-report-form';
import { BalanceSheetTable } from '../components/balance-sheet-table';
import { DisclosuresFields } from '../components/disclosures-fields';
import { ReadinessBanner } from '../components/readiness-banner';


const message = (error: unknown): string | undefined => (error instanceof Error ? error.message : undefined);

function AnnualReportEditor({ report }: Readonly<{ report: AnnualReport }>) {
  const { t } = useI18n();
  const ta = t.weldbooksNl.annualReports;
  const tx = ta.actions;
  const { formatDate, formatDateTime } = useWeldbooksFormat();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const id = report.id;

  const updateMutation = useUpdateAnnualReport(id);
  const recalculateMutation = useRecalculateAnnualReport(id);
  const fileMutation = useFileAnnualReport(id);
  const markFiledMutation = useMarkAnnualReportFiled(id);
  const statusMutation = useAnnualReportFilingStatus(id);
  const deleteMutation = useDeleteAnnualReport(id);

  const [confirmFile, setConfirmFile] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRecalculate, setConfirmRecalculate] = useState(false);
  const [markFiledOpen, setMarkFiledOpen] = useState(false);

  const form = useForm<AnnualReportFormValues>({
    resolver: zodResolver(annualReportFormSchema),
    defaultValues: reportToFormValues(report),
  });
  const { reset } = form;

  // A save, a recalculation or a filing changes the report: show what the server holds.
  useEffect(() => {
    reset(reportToFormValues(report));
  }, [report, reset]);

  const editable = isAnnualReportEditable(report.status);
  const dirty = form.formState.isDirty;
  const kvkDigipoort = isFeatureAvailable('kvk-digipoort');
  const canUpdate = can('reports:update');
  const notReady = report.issues.length > 0;

  const save = (values: AnnualReportFormValues) =>
    updateMutation.mutate(formValuesToPatch(values, report), {
      onSuccess: () => toast.success(tx.saved),
      onError: (err) => toast.error(tx.saveFailed, { description: message(err) }),
    });

  const recalculate = () =>
    recalculateMutation.mutate(undefined, {
      onSuccess: () => toast.success(ta.recalculate.done),
      onError: (err) => toast.error(ta.recalculate.failed, { description: message(err) }),
      onSettled: () => setConfirmRecalculate(false),
    });

  const handleDownload = async () => {
    try {
      const { blob, filename } = await accountingApi.downloadAnnualReportXbrl(id);
      downloadBlob(blob, filename ?? `jaarrekening-${report.fiscalYear}.xbrl`);
    } catch (err) {
      toast.error(tx.xbrlFailed, { description: message(err) });
    }
  };

  const file = () =>
    fileMutation.mutate(undefined, {
      onSuccess: () => toast.success(tx.submitted),
      onError: (err) => toast.error(tx.fileFailed, { description: message(err) }),
      onSettled: () => setConfirmFile(false),
    });

  const checkStatus = () =>
    statusMutation.mutate(undefined, {
      onSuccess: (res) => {
        if (res.data.success === false) {
          toast.error(res.data.error ?? t.weldbooksNl.digipoort.statusCheckFailed);
          return;
        }
        toast.info(tx.statusResult.replace('{status}', t.weldbooksNl.digipoort.statusLabels[res.data.status]));
      },
      onError: (err) => toast.error(message(err) ?? t.weldbooksNl.digipoort.statusCheckFailed),
    });

  const remove = () =>
    deleteMutation.mutate(undefined, {
      onSuccess: () => {
        toast.success(tx.deleted);
        setConfirmDelete(false);
        void navigate({ to: '/weldbooks/annual-reports' });
      },
      onError: (err) => {
        toast.error(tx.deleteFailed, { description: message(err) });
        setConfirmDelete(false);
      },
    });

  const filingFields = [
    { label: ta.filing.status, value: <AnnualReportStatusChip status={report.status} /> },
    { label: kvkDigipoort ? ta.filing.referenceDigipoort : ta.filing.reference, value: report.filingReference },
    { label: ta.filing.filedAt, value: report.filedAt ? formatDateTime(report.filedAt) : null },
    ...(report.acceptedAt ? [{ label: ta.filing.acceptedAt, value: formatDate(report.acceptedAt) }] : []),
    ...(report.rejectedAt ? [{ label: ta.filing.rejectedAt, value: formatDate(report.rejectedAt) }] : []),
  ];

  return (
    <DetailPage className="mx-auto max-w-5xl">
      <DetailHeader
        onBack={() => void navigate({ to: '/weldbooks/annual-reports' })}
        backLabel={ta.detail.back}
        title={ta.detail.title.replace('{year}', String(report.fiscalYear))}
        subtitle={`${ta.detail.periodLabel}: ${formatDate(report.periodStart)} — ${formatDate(report.periodEnd)}`}
        badges={
          <>
            <AnnualReportStatusChip status={report.status} />
            <PreprodBadge row={report} />
          </>
        }
        actions={
          <>
            {editable && canUpdate ? (
              <Button type="submit" form="annual-report-form" size="sm" disabled={!dirty || updateMutation.isPending}>
                {updateMutation.isPending ? tx.saving : tx.save}
              </Button>
            ) : null}
            {editable && canUpdate && kvkDigipoort ? (
              <Button
                size="sm"
                variant="outline"
                disabled={notReady || dirty || fileMutation.isPending}
                title={dirty ? ta.detail.unsavedChanges : undefined}
                onClick={() => setConfirmFile(true)}
              >
                <Send className="h-3.5 w-3.5" />
                {fileMutation.isPending ? tx.filing : tx.file}
              </Button>
            ) : null}
            {report.status === 'submitted' && kvkDigipoort ? (
              <Button size="sm" variant="outline" disabled={statusMutation.isPending} onClick={checkStatus}>
                <ShieldCheck className="h-3.5 w-3.5" />
                {statusMutation.isPending ? tx.checking : tx.checkStatus}
              </Button>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={tx.more}>
                  <EllipsisVertical className="h-4 w-4 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={notReady} onClick={() => void handleDownload()}>
                  <Download />
                  {tx.downloadXbrl}
                </DropdownMenuItem>
                {editable && canUpdate ? (
                  <>
                    <DropdownMenuItem
                      disabled={recalculateMutation.isPending}
                      onClick={() => (report.figures.edited ? setConfirmRecalculate(true) : recalculate())}
                    >
                      <RefreshCw />
                      {recalculateMutation.isPending ? ta.recalculate.pending : ta.recalculate.action}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setMarkFiledOpen(true)}>
                      <CheckCircle2 />
                      {tx.markFiled}
                    </DropdownMenuItem>
                  </>
                ) : null}
                {editable && can('reports:delete') ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                      <Trash2 />
                      {tx.delete}
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <ReadinessBanner report={report} />
      {fileMutation.isError ? (
        <InfoBanner variant="danger" title={tx.fileFailed}>
          {message(fileMutation.error)}
        </InfoBanner>
      ) : null}

      <DisclosuresFields form={form} report={report} editable={editable && canUpdate} onSubmit={save}>
        <section aria-labelledby="balance-title" className="space-y-3">
          <h2 id="balance-title" className="text-base font-semibold">
            {ta.balance.title}
          </h2>
          <BalanceSheetTable report={report} control={form.control} setValue={form.setValue} editable={editable && canUpdate} />
        </section>
      </DisclosuresFields>

      <section aria-labelledby="filing-title" className="space-y-3">
        <h2 id="filing-title" className="text-base font-semibold">
          {ta.filing.title}
        </h2>
        <FieldGrid fields={filingFields} />
        {statusMutation.data?.data ? <FilingStatusSummary status={statusMutation.data.data} /> : null}
      </section>

      <MarkVatFiledDialog
        open={markFiledOpen}
        onOpenChange={setMarkFiledOpen}
        pending={markFiledMutation.isPending}
        title={tx.markFiledTitle}
        description={tx.markFiledDescription}
        onSubmit={(values) =>
          markFiledMutation.mutate(values, {
            onSuccess: () => {
              setMarkFiledOpen(false);
              toast.success(tx.markedFiled);
            },
            onError: (err) => toast.error(tx.markFiledFailed, { description: message(err) }),
          })
        }
      />
      <ConfirmDialog
        open={confirmFile}
        onOpenChange={setConfirmFile}
        title={tx.fileConfirmTitle}
        description={tx.fileConfirmDescription}
        confirmLabel={tx.fileConfirm}
        cancelLabel={tx.fileConfirmCancel}
        loading={fileMutation.isPending}
        onConfirm={file}
      />
      <ConfirmDialog
        open={confirmRecalculate}
        onOpenChange={setConfirmRecalculate}
        title={ta.recalculate.confirmTitle}
        description={ta.recalculate.confirmDescription}
        confirmLabel={ta.recalculate.action}
        loading={recalculateMutation.isPending}
        onConfirm={recalculate}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={tx.deleteTitle}
        description={tx.deleteDescription}
        confirmLabel={tx.delete}
        cancelLabel={tx.keep}
        variant="destructive"
        loading={deleteMutation.isPending}
        onConfirm={remove}
      />
    </DetailPage>
  );
}

function AnnualReportDetail({ id }: Readonly<{ id: string }>) {
  const { t } = useI18n();
  const td = t.weldbooksNl.annualReports.detail;
  const query = useAnnualReport(id);
  const report = query.data?.data;

  if (query.isLoading) return <PageLoader fullScreen={false} />;
  if (query.isError) return <ErrorState className="m-4 sm:m-6" message={td.loadFailed} />;
  if (!report) return <div className="p-6 text-center text-sm text-muted-foreground">{td.notFound}</div>;
  return <AnnualReportEditor report={report} />;
}

export default function AnnualReportPage() {
  const { id } = useParams({ from: '/weldbooks/annual-reports/$id/' });
  const { t } = useI18n();
  return (
    <JurisdictionGate
      feature={t.weldbooksNl.annualReports.title}
      when={({ features }) => features.vatReturn && isFeatureAvailable('annual-reports')}
    >
      <AnnualReportDetail id={id} />
    </JurisdictionGate>
  );
}
