import { useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, Download, ExternalLink, FileX, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import {
  useCalculateTaxReturn,
  useDeleteTaxReturn,
  usePreFileCheck,
  useReviewTaxReturn,
  useReturnExceptions,
  useTaxReturn,
} from '@/hooks/queries/use-weldbooks-sales-tax-center-queries';
import { downloadBlob } from '@/lib/weldbooks/download';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import {
  EDITABLE_RETURN_STATUSES,
  FILED_RETURN_STATUSES,
  isSalesTaxRequestError,
  salesTaxCenterApi,
} from '@/lib/api/domains/weldbooks-sales-tax-center';
import { ReturnStatusBadge } from '../../shared/badges';
import { Notice } from '../../shared/notice';
import { EmptyState, ErrorState } from '../../shared/query-states';
import { SalesTaxGate } from '../../shared/sales-tax-frame';
import { daysUntil, dueCountdown, dueTone, fill } from '../../shared/text';
import { AdjustmentsCard } from '../components/adjustments-card';
import { DocumentsCard } from '../components/documents-card';
import { ExceptionsCard } from '../components/exceptions-card';
import { FileReturnDialog } from '../components/file-return-dialog';
import { LiabilityCheckCard } from '../components/liability-check-card';
import { PaymentDialog } from '../components/payment-dialog';
import { PreFileCheckCard } from '../components/pre-file-check-card';
import { AmendmentsCard, FilingCard, NotesCard } from '../components/return-info-cards';
import { ReturnStepper } from '../components/return-stepper';
import { WorksheetCard } from '../components/worksheet-card';

type ReturnTab = 'worksheet' | 'documents' | 'checks' | 'exceptions';

function ReturnSkeleton() {
  const { t } = useI18n();
  return (
    <div className="space-y-4" role="status" aria-label={t.weldbooksUs.salesTax.center.common.loading}>
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-6 w-96" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function ReturnContent({ id }: Readonly<{ id: string }>) {
  const { t } = useI18n();
  const tc = t.weldbooksUs.salesTax.center;
  const tr = tc.returnPage;
  const { can } = usePermissions();
  const navigate = useNavigate();
  const { formatDate } = useWeldbooksFormat();

  const returnQuery = useTaxReturn(id);
  const ret = returnQuery.data;
  const status = ret?.status ?? 'open';
  const filed = FILED_RETURN_STATUSES.includes(status);
  const editable = EDITABLE_RETURN_STATUSES.includes(status);

  const [tab, setTab] = useState<ReturnTab>('worksheet');
  const [fileOpen, setFileOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const calculate = useCalculateTaxReturn(id);
  const review = useReviewTaxReturn(id);
  const remove = useDeleteTaxReturn();
  // The stepper needs to know whether the check was clean once the return is reviewed.
  const preFile = usePreFileCheck(id, { enabled: status === 'reviewed' });
  const exceptions = useReturnExceptions(id, { enabled: filed });

  const canUpdate = can('taxes:update');
  const canFile = can('taxes:file');
  const canDelete = can('taxes:delete');
  const canCreate = can('taxes:create');

  /** Calculates the return; false when it did not work (the user was told). */
  const calculateReturn = async (): Promise<boolean> => {
    try {
      await calculate.mutateAsync();
      toast.success(tr.toasts.calculated);
      return true;
    } catch (err) {
      toast.error(tr.toasts.calculateFailed, { description: err instanceof Error ? err.message : undefined });
      return false;
    }
  };

  const reviewReturn = async () => {
    try {
      await review.mutateAsync();
      toast.success(tr.toasts.reviewed);
    } catch (err) {
      toast.error(tr.toasts.reviewFailed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  const deleteReturn = async () => {
    try {
      await remove.mutateAsync(id);
      toast.success(tr.toasts.deleted);
      setDeleteOpen(false);
      await navigate({ to: '/weldbooks/sales-tax/returns' });
    } catch (err) {
      toast.error(tr.toasts.deleteFailed, { description: err instanceof Error ? err.message : undefined });
      setDeleteOpen(false);
    }
  };

  const exportCsv = async () => {
    if (!ret) return;
    setExporting(true);
    try {
      const { blob, filename } = await salesTaxCenterApi.exportReturn(id);
      downloadBlob(blob, filename ?? `sales-tax-${ret.agency.stateCode.toLowerCase()}-${ret.periodStart}-${ret.periodEnd}.csv`);
    } catch (err) {
      toast.error(tr.toasts.exportFailed, { description: err instanceof Error ? err.message : undefined });
    } finally {
      setExporting(false);
    }
  };

  if (returnQuery.isLoading) return <ReturnSkeleton />;
  if (returnQuery.isError || !ret) {
    const notFound = isSalesTaxRequestError(returnQuery.error) && returnQuery.error.status === 404;
    return notFound ? (
      <EmptyState
        icon={FileX}
        title={tr.notFoundTitle}
        description={tr.notFoundDescription}
        action={
          <Button asChild variant="outline">
            <Link to="/weldbooks/sales-tax/returns">{tr.back}</Link>
          </Button>
        }
      />
    ) : (
      <ErrorState error={returnQuery.error} onRetry={() => void returnQuery.refetch()} />
    );
  }

  const bases = tc.bases as Record<string, string>;
  const calculated = ret.summary !== null;
  const openExceptions = exceptions.data?.totals.open.documents ?? 0;
  const unfiledTone = ret.dueDate && !filed ? dueTone(daysUntil(ret.dueDate)) : 'later';
  const preFileOk = preFile.data?.ok === true;
  const busy = calculate.isPending || review.isPending;

  const primary =
    status === 'open' && canUpdate
      ? 'calculate'
      : status === 'calculated' && canUpdate
        ? 'review'
        : status === 'reviewed' && canFile
          ? 'file'
          : status === 'filed' && canFile
            ? 'pay'
            : null;

  return (
    <div className="space-y-4">
      <div>
        <Link
          to="/weldbooks/sales-tax/returns"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          {tr.back}
        </Link>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold">{fill(tr.title, { agency: ret.agency.name })}</h1>
            <ReturnStatusBadge status={status} />
            {ret.amendsReturnId ? (
              <Link to="/weldbooks/sales-tax/returns/$id" params={{ id: ret.amendsReturnId }}>
                <Badge variant="outline" className="hover:bg-accent">
                  {tr.amendedReturn}
                </Badge>
              </Link>
            ) : null}
            {ret.overdue ? <Badge variant="destructive">{tr.overdue}</Badge> : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {fill(tr.periodRange, { start: formatDate(ret.periodStart), end: formatDate(ret.periodEnd) })}
            {ret.dueDate ? (
              <>
                {' · '}
                <span
                  className={cn(
                    !filed && unfiledTone === 'overdue' && 'font-medium text-destructive',
                    !filed && unfiledTone === 'soon' && 'text-amber-600 dark:text-amber-400',
                  )}
                >
                  {fill(tr.due, { date: formatDate(ret.dueDate) })}
                  {filed ? '' : ` (${dueCountdown(tc.due, daysUntil(ret.dueDate))})`}
                </span>
              </>
            ) : null}
            {' · '}
            {fill(tc.basisLabel, { basis: bases[ret.reportingBasis] ?? ret.reportingBasis })}
            {ret.agency.registrationNumber ? ` · ${fill(tr.registration, { number: ret.agency.registrationNumber })}` : ''}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {ret.agency.portalUrl ? (
            <Button asChild variant="ghost" size="sm">
              <a href={ret.agency.portalUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="mr-1 h-4 w-4" aria-hidden="true" />
                {tr.actions.openPortal}
              </a>
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => void exportCsv()} disabled={exporting}>
            {exporting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden="true" /> : <Download className="mr-1 h-4 w-4" aria-hidden="true" />}
            {exporting ? tr.actions.exporting : tr.actions.exportCsv}
          </Button>
          {editable && canDelete ? (
            <Button variant="outline" size="sm" onClick={() => setDeleteOpen(true)}>
              <Trash2 className="mr-1 h-4 w-4" aria-hidden="true" />
              {tr.actions.deleteReturn}
            </Button>
          ) : null}
          {(status === 'calculated' || status === 'reviewed') && canUpdate ? (
            <Button variant="outline" size="sm" onClick={() => void calculateReturn()} disabled={busy}>
              {calculate.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {tr.actions.recalculate}
            </Button>
          ) : null}
          {primary === 'calculate' ? (
            <Button size="sm" onClick={() => void calculateReturn()} disabled={busy}>
              {calculate.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {tr.actions.calculate}
            </Button>
          ) : null}
          {primary === 'review' ? (
            <Button size="sm" onClick={() => void reviewReturn()} disabled={busy}>
              {review.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {tr.actions.markReviewed}
            </Button>
          ) : null}
          {primary === 'file' ? (
            <Button size="sm" onClick={() => setFileOpen(true)}>
              {tr.actions.fileReturn}
            </Button>
          ) : null}
          {primary === 'pay' ? (
            <Button size="sm" onClick={() => setPayOpen(true)}>
              {tr.actions.recordPayment}
            </Button>
          ) : null}
        </div>
      </div>

      <Card>
        <CardContent className="p-4">
          <ReturnStepper status={status} preFileOk={preFileOk} />
        </CardContent>
      </Card>

      {openExceptions > 0 ? (
        <Notice
          tone="warning"
          data-testid="exceptions-banner"
          action={
            <Button variant="outline" size="sm" onClick={() => setTab('exceptions')}>
              {tr.exceptions.review}
            </Button>
          }
        >
          <p>{openExceptions === 1 ? tr.exceptions.bannerOne : fill(tr.exceptions.bannerMany, { count: openExceptions })}</p>
        </Notice>
      ) : null}

      <Tabs value={tab} onValueChange={(value) => setTab(value as ReturnTab)}>
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="worksheet">{tr.tabs.worksheet}</TabsTrigger>
          <TabsTrigger value="documents">{tr.tabs.documents}</TabsTrigger>
          <TabsTrigger value="checks">{tr.tabs.checks}</TabsTrigger>
          {filed ? <TabsTrigger value="exceptions">{tr.tabs.exceptions}</TabsTrigger> : null}
        </TabsList>

        <TabsContent value="worksheet" className="space-y-4">
          {filed ? <FilingCard ret={ret} /> : null}
          {calculated ? (
            <>
              <WorksheetCard ret={ret} />
              <AdjustmentsCard ret={ret} canEdit={editable && canUpdate} />
            </>
          ) : (
            <EmptyState
              title={tr.notCalculated.title}
              description={tr.notCalculated.description}
              action={
                canUpdate ? (
                  <Button onClick={() => void calculateReturn()} disabled={busy}>
                    {calculate.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                    {tr.actions.calculate}
                  </Button>
                ) : undefined
              }
            />
          )}
          <AmendmentsCard ret={ret} />
          <NotesCard ret={ret} canEdit={canUpdate} />
        </TabsContent>

        <TabsContent value="documents" className="space-y-4">
          <DocumentsCard returnId={id} enabled={tab === 'documents'} />
        </TabsContent>

        <TabsContent value="checks" className="space-y-4">
          <PreFileCheckCard ret={ret} enabled={tab === 'checks'} />
          <LiabilityCheckCard ret={ret} enabled={tab === 'checks'} />
        </TabsContent>

        {filed ? (
          <TabsContent value="exceptions" className="space-y-4">
            <ExceptionsCard ret={ret} canCarryForward={canUpdate} canAmend={canCreate} />
          </TabsContent>
        ) : null}
      </Tabs>

      <FileReturnDialog
        ret={ret}
        open={fileOpen}
        onOpenChange={setFileOpen}
        findingsCount={preFile.data?.findings.length ?? 0}
        onRecalculate={calculateReturn}
        onRecordPayment={() => setPayOpen(true)}
      />
      <PaymentDialog ret={ret} open={payOpen} onOpenChange={setPayOpen} />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={tr.deleteConfirm.title}
        description={tr.deleteConfirm.description}
        confirmLabel={tr.deleteConfirm.confirm}
        cancelLabel={tc.common.cancel}
        variant="destructive"
        loading={remove.isPending}
        onConfirm={deleteReturn}
      />
    </div>
  );
}

/** One return of the Sales Tax Center: the worksheet and the flow from calculation to payment. */
export default function SalesTaxReturnPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  return (
    <SalesTaxGate>
      <div className="p-4 sm:p-6">
        <ReturnContent id={id} />
      </div>
    </SalesTaxGate>
  );
}
