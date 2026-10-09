import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { toast } from 'sonner';
import { ArrowLeft, Download, Eye, Loader2, Printer, Settings } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { PageLoader } from '@/components/page-loader';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useI18n } from '@/lib/i18n/provider';
import { renderChecksPdf } from '@/lib/weldbooks/check-pdf';
import { downloadBlob } from '@/lib/weldbooks/download';
import { pdfBlob, printPdfBytes } from '@/lib/weldbooks/print-pdf';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useCheckPrintData, useMarkChecksPrinted, usePaymentRun } from '@/hooks/queries/use-weldbooks-payment-runs-queries';
import type { CheckPrintItem } from '@/lib/api/domains/weldbooks-payment-runs';
import { PaymentRunsFrame } from '../../components/payment-runs-frame';
import { CheckStatusBadge } from '../../components/run-badges';
import { useCheckPdfLabels } from '../../components/use-check-pdf-labels';
import { VoidCheckDialog, type VoidableCheck } from '../../components/void-check-dialog';
import { describeRunError } from '../../run-errors';

export default function PrintChecksPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { t } = useI18n();
  const tp = t.weldbooksUs.payments;
  const tc = tp.printChecks;
  const { can } = usePermissions();
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const labels = useCheckPdfLabels();
  const canManage = can('banking:manage');

  const [includePrinted, setIncludePrinted] = useState(false);
  const runQuery = usePaymentRun(canManage ? id : undefined);
  const printQuery = useCheckPrintData(canManage ? id : undefined, includePrinted);
  const markPrinted = useMarkChecksPrinted();

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<'preview' | 'download' | 'print' | null>(null);
  const [generated, setGenerated] = useState(false);
  const [voiding, setVoiding] = useState<VoidableCheck | null>(null);
  const [confirmMark, setConfirmMark] = useState(false);

  const data = printQuery.data;
  const checks = useMemo(() => data?.checks ?? [], [data]);
  const toPrint = useMemo(() => checks.filter((c) => c.checkStatus === 'to_print'), [checks]);

  // Whatever is still to print starts selected; a reprint is picked by hand.
  useEffect(() => {
    setSelected(new Set(toPrint.map((c) => c.paymentId)));
    setGenerated(false);
  }, [toPrint]);

  // The preview is a blob URL: free it when it is replaced and when the page goes.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const chosen: CheckPrintItem[] = useMemo(() => checks.filter((c) => selected.has(c.paymentId)), [checks, selected]);
  const chosenToPrint = chosen.filter((c) => c.checkStatus === 'to_print');

  const build = useCallback(async () => {
    if (!data || chosen.length === 0) return null;
    return renderChecksPdf({ ...data, checks: chosen }, labels);
  }, [data, chosen, labels]);

  const run = async (action: 'preview' | 'download' | 'print') => {
    setBusy(action);
    try {
      const result = await build();
      if (!result) return;
      if (action === 'preview') {
        setPreviewUrl(URL.createObjectURL(pdfBlob(result.bytes)));
        return;
      }
      if (action === 'download') downloadBlob(pdfBlob(result.bytes), `checks-${data?.run.paymentDate ?? id}.pdf`);
      else printPdfBytes(result.bytes);
      // Only a download or a print counts: a preview proves nothing came out of the printer.
      setGenerated(true);
    } catch {
      toast.error(tc.pdfFailed);
    } finally {
      setBusy(null);
    }
  };

  const toggle = (paymentId: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(paymentId);
      else next.delete(paymentId);
      return next;
    });
  };

  const allSelected = checks.length > 0 && checks.every((c) => selected.has(c.paymentId));

  const frameProps = {
    title: tc.title,
    subtitle: runQuery.data ? `${runQuery.data.bankAccountName ?? ''} · ${formatDate(runQuery.data.paymentDate)}` : undefined,
    actions: (
      <Button asChild variant="outline" size="sm">
        <Link to="/weldbooks/payment-runs/$id" params={{ id }}>
          <ArrowLeft className="h-4 w-4" />
          {tc.backToRun}
        </Link>
      </Button>
    ),
  };

  if (!canManage) {
    return (
      <PaymentRunsFrame {...frameProps}>
        <p className="text-sm text-muted-foreground">{tp.common.noPermission}</p>
      </PaymentRunsFrame>
    );
  }

  if (printQuery.isLoading || runQuery.isLoading) {
    return (
      <PaymentRunsFrame {...frameProps}>
        <PageLoader fullScreen={false} />
      </PaymentRunsFrame>
    );
  }

  if (printQuery.isError || !data) {
    return (
      <PaymentRunsFrame {...frameProps}>
        <div className="space-y-2">
          <p className="text-sm text-destructive" role="alert">
            {describeRunError(printQuery.error, tp.errors, tp.common.loadFailed)}
          </p>
          <Button variant="outline" size="sm" onClick={() => printQuery.refetch()}>{tp.common.retry}</Button>
        </div>
      </PaymentRunsFrame>
    );
  }

  const first = chosenToPrint[0]?.checkNumber ?? chosen[0]?.checkNumber;

  return (
    <PaymentRunsFrame {...frameProps}>
      {data.settings.printMicr ? (
        <Alert>
          <Printer />
          <AlertTitle>{tc.micrNotice.title}</AlertTitle>
          <AlertDescription>
            <p>{tc.micrNotice.body}</p>
            <p className="mt-1">{tc.micrNotice.action}</p>
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{tc.checksTitle}</CardTitle>
          <CardDescription>
            {data.settings.printMicr ? tc.stockBlank : tc.stockPreprinted}
            {first ? ` ${tc.loadFirst.replace('{number}', first)}` : ''}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Checkbox
                id="include-printed"
                checked={includePrinted}
                onCheckedChange={(checked) => setIncludePrinted(checked === true)}
              />
              <label htmlFor="include-printed" className="text-sm">{tc.includePrinted}</label>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link to="/weldbooks/payment-runs/settings/$bankAccountId" params={{ bankAccountId: data.run.bankAccountId }}>
                <Settings className="h-4 w-4" aria-hidden />
                {tc.alignmentSettings}
              </Link>
            </Button>
          </div>

          {checks.length === 0 ? (
            <p className="text-sm text-muted-foreground">{tc.nothingToPrint}</p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox
                        aria-label={tc.selectAll}
                        checked={allSelected}
                        onCheckedChange={(checked) => setSelected(checked === true ? new Set(checks.map((c) => c.paymentId)) : new Set())}
                      />
                    </TableHead>
                    <TableHead>{tc.columns.number}</TableHead>
                    <TableHead>{tc.columns.payee}</TableHead>
                    <TableHead>{tc.columns.date}</TableHead>
                    <TableHead>{tc.columns.status}</TableHead>
                    <TableHead className="text-right">{tc.columns.amount}</TableHead>
                    <TableHead className="w-px" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {checks.map((check) => (
                    <TableRow key={check.paymentId}>
                      <TableCell>
                        <Checkbox
                          aria-label={tc.selectCheck.replace('{number}', check.checkNumber)}
                          checked={selected.has(check.paymentId)}
                          onCheckedChange={(checked) => toggle(check.paymentId, checked === true)}
                        />
                      </TableCell>
                      <TableCell className="font-medium tabular-nums">{check.checkNumber}</TableCell>
                      <TableCell>{check.payee.name}</TableCell>
                      <TableCell className="whitespace-nowrap">{formatDate(check.date)}</TableCell>
                      <TableCell><CheckStatusBadge status={check.checkStatus} /></TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMoney(check.amount)}
                        {check.backupWithholdingAmount ? (
                          <p className="text-xs font-normal text-muted-foreground">
                            {tc.withholdingLine
                              .replace('{gross}', formatMoney(check.grossAmount))
                              .replace('{withheld}', formatMoney(check.backupWithholdingAmount))}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setVoiding({
                              paymentId: check.paymentId,
                              checkNumber: check.checkNumber,
                              payeeName: check.payee.name,
                              amount: check.amount,
                              backupWithholdingAmount: check.backupWithholdingAmount,
                            })
                          }
                        >
                          {tc.voidAction}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => run('preview')} disabled={chosen.length === 0 || busy !== null}>
              {busy === 'preview' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
              {tc.preview}
            </Button>
            <Button variant="outline" onClick={() => run('download')} disabled={chosen.length === 0 || busy !== null}>
              {busy === 'download' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
              {tc.download}
            </Button>
            <Button onClick={() => run('print')} disabled={chosen.length === 0 || busy !== null}>
              {busy === 'print' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Printer className="h-4 w-4" aria-hidden />}
              {tc.print}
            </Button>
          </div>
        </CardContent>
      </Card>

      {previewUrl ? (
        <Card>
          <CardHeader>
            <CardTitle>{tc.previewTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            <iframe title={tc.previewTitle} src={previewUrl} className="h-[70vh] w-full rounded-md border" />
          </CardContent>
        </Card>
      ) : null}

      {toPrint.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{tc.markTitle}</CardTitle>
            <CardDescription>{tc.markDescription}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button onClick={() => setConfirmMark(true)} disabled={!generated || chosenToPrint.length === 0 || markPrinted.isPending}>
              {markPrinted.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {tc.markPrinted.replace('{count}', String(chosenToPrint.length))}
            </Button>
            {!generated ? <p className="text-sm text-muted-foreground">{tc.markNeedsPrint}</p> : null}
          </CardContent>
        </Card>
      ) : null}

      <VoidCheckDialog check={voiding} onOpenChange={(open) => { if (!open) setVoiding(null); }} />

      <ConfirmDialog
        open={confirmMark}
        onOpenChange={setConfirmMark}
        title={tc.markConfirmTitle}
        description={tc.markConfirmDescription.replace('{count}', String(chosenToPrint.length))}
        confirmLabel={tc.markConfirm}
        cancelLabel={tp.common.cancel}
        onConfirm={async () => {
          try {
            const result = await markPrinted.mutateAsync({ id, paymentIds: chosenToPrint.map((c) => c.paymentId) });
            toast.success(tc.marked.replace('{count}', String(result.printed.length)));
          } catch (err) {
            toast.error(tc.markFailed, { description: describeRunError(err, tp.errors, tp.errors.generic) });
          } finally {
            setConfirmMark(false);
          }
        }}
      />
    </PaymentRunsFrame>
  );
}
