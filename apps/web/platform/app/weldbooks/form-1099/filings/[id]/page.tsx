import { useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { AlertCircle, AlertTriangle, ArrowLeft, Download, FileSpreadsheet, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageLoader } from '@/components/page-loader';
import {
  useDeleteForm1099Filing,
  useForm1099Filing,
  useGenerateForm1099Filing,
  useMarkForm1099Delivered,
  useRefreshForm1099Filing,
  useReviewForm1099Filing,
  useUpdateForm1099FilingNotes,
} from '@/hooks/queries/use-weldbooks-1099-queries';
import type { Form1099Copy, Form1099FilingLine } from '@/lib/api/domains/weldbooks-1099';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { FilingStatusBadge } from '../../components/filing-status-badge';
import { copyTargets, hasOutputs, isEditableFiling, liveLines, unresolvedLines } from '../../form-1099-model';
import { CorrectionDialog } from './components/correction-dialog';
import { FilingStepper } from './components/filing-stepper';
import { IrisDialog } from './components/iris-dialog';
import { LineEditorDialog } from './components/line-editor-dialog';
import { LinesTable } from './components/lines-table';
import { MarkFiledDialog } from './components/mark-filed-dialog';
import { downloadCopies } from './copies';

/** Lines the server says block generating, from the 409 it answers with. */
function blockingLines(err: unknown): Array<{ lineId: string; partyId: string; name: string | null; status: string }> {
  const lines = (err as { body?: { error?: { details?: { lines?: unknown } } } } | null)?.body?.error?.details?.lines;
  return Array.isArray(lines) ? (lines as Array<{ lineId: string; partyId: string; name: string | null; status: string }>) : [];
}

export default function Form1099FilingPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { t } = useI18n();
  const tf = t.weldbooksUs.form1099.filing;
  const { can } = usePermissions();
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const navigate = useNavigate();

  const query = useForm1099Filing(id);
  const refresh = useRefreshForm1099Filing(id);
  const review = useReviewForm1099Filing(id);
  const generate = useGenerateForm1099Filing(id);
  const remove = useDeleteForm1099Filing();
  const delivered = useMarkForm1099Delivered(id);
  const saveNotes = useUpdateForm1099FilingNotes(id);

  const [editing, setEditing] = useState<Form1099FilingLine | null>(null);
  const [correcting, setCorrecting] = useState<Form1099FilingLine | null>(null);
  const [irisOpen, setIrisOpen] = useState(false);
  const [filedOpen, setFiledOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [blockers, setBlockers] = useState<Array<{ lineId: string; partyId: string; name: string | null; status: string }>>([]);
  const [busyLineId, setBusyLineId] = useState<string | null>(null);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const [notes, setNotes] = useState<string | null>(null);

  if (query.isLoading) return <PageLoader fullScreen={false} />;
  if (query.isError || !query.data) {
    const notFound = (query.error as { status?: number } | null)?.status === 404;
    return (
      <div className="flex flex-col items-center gap-3 p-10 text-center" role="alert">
        <AlertCircle className="h-8 w-8 text-destructive" aria-hidden />
        <p className="text-sm text-muted-foreground">{notFound ? tf.notFound : tf.loadError}</p>
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to="/weldbooks/form-1099" search={{ tab: 'filings' }}>
              {tf.back}
            </Link>
          </Button>
          {notFound ? null : (
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              {tf.retry}
            </Button>
          )}
        </div>
      </div>
    );
  }

  const { filing, lines } = query.data;
  const formLabel = t.weldbooksUs.form1099.forms[filing.formType];
  const editable = isEditableFiling(filing.status);
  const outputs = hasOutputs(filing.status);
  const canUpdate = can('taxes:update');
  const canFile = can('taxes:file');
  const canIris = canFile && can('tax_ids:reveal');
  const open = unresolvedLines(lines);
  const targets = copyTargets(filing, lines);
  const included = liveLines(lines).filter((line) => line.status === 'included' || line.status === 'filed');
  const notesValue = notes ?? filing.notes ?? '';

  const run = async (action: () => Promise<unknown>, success: string, failure: string) => {
    try {
      await action();
      toast.success(success);
    } catch (err) {
      toast.error(failure, { description: err instanceof Error ? err.message : undefined });
    }
  };

  const doReview = async () => {
    try {
      const result = await review.mutateAsync();
      if (result.unresolved.length > 0) toast.warning(tf.reviewedWithOpen.replace('{n}', String(result.unresolved.length)));
      else toast.success(tf.reviewed);
    } catch (err) {
      toast.error(tf.reviewFailed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  const doRefresh = async () => {
    try {
      const result = await refresh.mutateAsync();
      toast.success(tf.refreshed.replace('{updated}', String(result.refresh.updated)).replace('{added}', String(result.refresh.added)));
    } catch (err) {
      toast.error(tf.refreshFailed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  const doGenerate = async () => {
    try {
      await generate.mutateAsync();
      setBlockers([]);
      toast.success(tf.generated);
      setGenerateOpen(false);
    } catch (err) {
      setGenerateOpen(false);
      setBlockers(blockingLines(err));
      toast.error(tf.generateFailed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  const doDelete = async () => {
    try {
      await remove.mutateAsync(id);
      toast.success(tf.deleted);
      navigate({ to: '/weldbooks/form-1099', search: { year: filing.taxYear, tab: 'filings' } });
    } catch (err) {
      toast.error(tf.deleteFailed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  const reportCopies = (result: Awaited<ReturnType<typeof downloadCopies>>) => {
    if (result.pages === 0) {
      toast.error(tf.copiesFailed, { description: result.failed[0]?.message });
      return;
    }
    toast.success(tf.copiesReady.replace('{n}', String(result.pages)));
    if (result.failed.length > 0) toast.warning(tf.copiesSkipped.replace('{n}', String(result.failed.length)), { description: result.failed[0]?.message });
    for (const warning of result.warnings) toast.warning(warning);
  };

  const downloadForLine = async (line: Form1099FilingLine, copies: readonly Form1099Copy[]) => {
    setBusyLineId(line.id);
    try {
      reportCopies(await downloadCopies({ filing, lines: [line], copies }));
    } catch (err) {
      toast.error(tf.copiesFailed, { description: err instanceof Error ? err.message : undefined });
    } finally {
      setBusyLineId(null);
    }
  };

  const downloadBatch = async (copies: readonly Form1099Copy[]) => {
    setBatchProgress({ done: 0, total: targets.length });
    try {
      reportCopies(
        await downloadCopies({
          filing,
          lines: targets,
          copies,
          onProgress: (done, total) => setBatchProgress({ done, total }),
        }),
      );
    } catch (err) {
      toast.error(tf.copiesFailed, { description: err instanceof Error ? err.message : undefined });
    } finally {
      setBatchProgress(null);
    }
  };

  const markDelivered = (line: Form1099FilingLine, method: 'print' | 'email') =>
    run(() => delivered.mutateAsync({ lineId: line.id, method }), tf.deliveryRecorded, tf.deliveryFailed);

  const nextStep: Record<typeof filing.status, string> = {
    draft: tf.nextDraft,
    reviewed: tf.nextReviewed,
    generated: tf.nextGenerated,
    filed: tf.nextFiled,
    corrected: tf.nextCorrected,
  };

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="space-y-3">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/weldbooks/form-1099" search={{ year: filing.taxYear, tab: 'filings' }}>
            <ArrowLeft className="mr-1 h-4 w-4" aria-hidden />
            {tf.back}
          </Link>
        </Button>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">
            {formLabel} · {filing.taxYear}
          </h1>
          <FilingStatusBadge status={filing.status} />
        </div>
        <FilingStepper status={filing.status} />
        <p className="max-w-3xl text-sm text-muted-foreground" data-testid="next-step">
          {nextStep[filing.status]}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card>
          <CardContent className="space-y-1 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{tf.recipients}</p>
            <p className="text-2xl font-semibold tabular-nums" data-testid="filing-recipients">
              {included.length}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-1 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{tf.reported}</p>
            <p className="text-2xl font-semibold tabular-nums" data-testid="filing-total">
              {formatMoney(filing.totals.amount)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-1 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{tf.withheld}</p>
            <p className="text-2xl font-semibold tabular-nums">{formatMoney(filing.totals.withheld)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-1 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{tf.filedOn}</p>
            <p className="text-lg font-semibold">{filing.filedAt ? formatDate(filing.filedAt) : '—'}</p>
            {filing.confirmationNumber ? <p className="break-all text-xs text-muted-foreground">{filing.confirmationNumber}</p> : null}
          </CardContent>
        </Card>
      </div>

      {open.length > 0 || blockers.length > 0 ? (
        <Alert variant="destructive" data-testid="filing-blockers">
          <AlertTriangle aria-hidden />
          <AlertTitle>{tf.blockersTitle.replace('{n}', String((blockers.length > 0 ? blockers : open).length))}</AlertTitle>
          <AlertDescription>
            <p className="mb-1">{tf.blockersHelp}</p>
            <ul className="space-y-0.5">
              {(blockers.length > 0 ? blockers : open.map((l) => ({ lineId: l.id, partyId: l.partyId, name: l.recipient?.name ?? l.partyName, status: l.status }))).map((b) => (
                <li key={b.lineId}>
                  <Link to="/weldbooks/customers/$id/edit" params={{ id: b.partyId }} className="underline">
                    {b.name ?? b.partyId}
                  </Link>{' '}
                  <span className="text-xs">({b.status === 'needs_tin' ? tf.needsTin : tf.needsAddress})</span>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2" data-testid="filing-actions">
        {editable && canUpdate ? (
          <Button type="button" variant="outline" onClick={() => void doRefresh()} disabled={refresh.isPending}>
            {refresh.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="mr-1 h-4 w-4" aria-hidden />}
            {tf.refresh}
          </Button>
        ) : null}
        {filing.status === 'draft' && canUpdate ? (
          <Button type="button" onClick={() => void doReview()} disabled={review.isPending}>
            {review.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : null}
            {tf.markReviewed}
          </Button>
        ) : null}
        {filing.status === 'reviewed' && canFile ? (
          <Button type="button" onClick={() => setGenerateOpen(true)} disabled={generate.isPending}>
            {generate.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : null}
            {tf.generate}
          </Button>
        ) : null}
        {outputs && canIris ? (
          <Button type="button" onClick={() => setIrisOpen(true)}>
            <FileSpreadsheet className="mr-1 h-4 w-4" aria-hidden />
            {filing.status === 'corrected' ? tf.irisCorrections : tf.iris}
          </Button>
        ) : null}
        {outputs && targets.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" disabled={batchProgress !== null}>
                {batchProgress ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : <Download className="mr-1 h-4 w-4" aria-hidden />}
                {batchProgress
                  ? tf.buildingCopies.replace('{done}', String(batchProgress.done)).replace('{total}', String(batchProgress.total))
                  : tf.downloadCopies}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72">
              <DropdownMenuItem onSelect={() => void downloadBatch(['B'])}>{tf.batchRecipient}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void downloadBatch(['1', '2'])}>{tf.batchState}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void downloadBatch(['C'])}>{tf.batchPayer}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void downloadBatch(['B', '1', '2', 'C'])}>{tf.batchAll}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {(filing.status === 'generated' || filing.status === 'corrected') && canFile ? (
          <Button type="button" variant="outline" onClick={() => setFiledOpen(true)}>
            {filing.status === 'corrected' ? tf.markCorrectionFiled : tf.markFiled}
          </Button>
        ) : null}
        {filing.status === 'draft' && can('taxes:delete') ? (
          <Button type="button" variant="ghost" className="ml-auto text-destructive hover:text-destructive" onClick={() => setDeleteOpen(true)}>
            {tf.delete}
          </Button>
        ) : null}
      </div>
      {outputs && !canIris ? <p className="text-xs text-muted-foreground">{tf.irisNeedsPermission}</p> : null}

      <LinesTable
        filing={filing}
        lines={lines}
        canUpdate={canUpdate}
        canFile={canFile}
        busyLineId={busyLineId}
        onEdit={setEditing}
        onCorrect={setCorrecting}
        onDownloadCopies={(line, copies) => void downloadForLine(line, copies)}
        onMarkDelivered={(line, method) => void markDelivered(line, method)}
      />

      {outputs ? <p className="max-w-3xl text-xs text-muted-foreground">{tf.deliveryNote}</p> : null}

      <section className="max-w-2xl space-y-2">
        <Label htmlFor="filing-notes">{tf.notes}</Label>
        <Textarea
          id="filing-notes"
          rows={3}
          maxLength={5000}
          value={notesValue}
          disabled={!canUpdate}
          onChange={(event) => setNotes(event.target.value)}
        />
        {canUpdate && notes !== null && notes !== (filing.notes ?? '') ? (
          <Button
            type="button"
            size="sm"
            disabled={saveNotes.isPending}
            onClick={() =>
              void run(
                async () => {
                  await saveNotes.mutateAsync(notes.trim() === '' ? null : notes);
                  setNotes(null);
                },
                tf.notesSaved,
                tf.notesFailed,
              )
            }
          >
            {tf.saveNotes}
          </Button>
        ) : null}
      </section>

      <LineEditorDialog filing={filing} line={editing} onOpenChange={(openState) => !openState && setEditing(null)} />
      <CorrectionDialog filing={filing} line={correcting} onOpenChange={(openState) => !openState && setCorrecting(null)} />
      <IrisDialog filingId={id} formLabel={formLabel} open={irisOpen} onOpenChange={setIrisOpen} />
      <MarkFiledDialog
        filingId={id}
        formLabel={formLabel}
        correction={filing.status === 'corrected'}
        open={filedOpen}
        onOpenChange={setFiledOpen}
      />
      <ConfirmDialog
        open={generateOpen}
        onOpenChange={setGenerateOpen}
        title={tf.generateTitle}
        description={tf.generateDescription}
        confirmLabel={tf.generateConfirm}
        cancelLabel={tf.cancel}
        loading={generate.isPending}
        onConfirm={doGenerate}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={tf.deleteTitle}
        description={tf.deleteDescription}
        confirmLabel={tf.deleteConfirm}
        cancelLabel={tf.cancel}
        variant="destructive"
        loading={remove.isPending}
        onConfirm={doDelete}
      />
    </div>
  );
}
