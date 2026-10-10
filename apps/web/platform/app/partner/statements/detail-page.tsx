/**
 * One statement: totals, the invoice links and one line per workspace. The
 * CSV is what the partner uses to invoice their own customers.
 */

import { ArrowLeft, Download, ExternalLink, FileText, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { fromCents, toCents } from '@weldsuite/app-api-client/schemas/partners';
import { usePartnerStatement, useStatementCsv } from '@/hooks/queries/use-partner-queries';
import { downloadBlob } from '@/lib/weldbooks/download';
import { useI18n } from '@/lib/i18n/provider';
import { usePartnerContext } from '@/lib/partner/partner-context';
import { Link, useParams } from '@/lib/router';
import {
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
  StatCard,
  StatementStatusBadge,
  errorText,
  useFormatters,
} from '../components/kit';

export default function PartnerStatementDetailPage() {
  const { t, format } = useI18n();
  const ts = t.partner.statements;
  const f = useFormatters();
  const { can } = usePartnerContext();
  const allowed = can('partner:billing:read');
  const { statementId } = useParams<{ statementId: string }>();
  const { data, isLoading, error, refetch } = usePartnerStatement(statementId, allowed);
  const csv = useStatementCsv();

  const back = (
    <Link
      href="/partner/statements"
      className="mb-4 inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden />
      {ts.backToList}
    </Link>
  );

  if (!allowed) {
    return (
      <>
        {back}
        <EmptyBlock icon={FileText} title={ts.noBillingAccess} />
      </>
    );
  }
  if (isLoading) {
    return (
      <>
        {back}
        <LoadingBlock rows={5} />
      </>
    );
  }
  if (error || !data) {
    return (
      <>
        {back}
        {error ? (
          <ErrorBlock message={errorText(error, t.partner.common.loadFailed)} onRetry={() => void refetch()} />
        ) : (
          <EmptyBlock icon={FileText} title={ts.notFound} />
        )}
      </>
    );
  }

  const download = async () => {
    try {
      const text = await csv.mutateAsync(statementId);
      const period = data.periodStart.slice(0, 7);
      downloadBlob(new Blob([text], { type: 'text/csv;charset=utf-8' }), `weldsuite-statement-${period}.csv`);
    } catch (err) {
      toast.error(errorText(err, ts.csvFailed));
    }
  };

  const money = (amount: string) => f.money(amount, data.currency);

  return (
    <div className="space-y-6">
      {back}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{f.month(data.periodStart)}</h1>
            <StatementStatusBadge status={data.status} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {data.status === 'preview'
              ? ts.previewNote
              : data.paidAt
                ? format(ts.paidOn, { date: f.date(data.paidAt) })
                : data.dueAt
                  ? format(ts.dueDate, { date: f.date(data.dueAt) })
                  : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {data.stripeInvoiceUrl && (
            <Button asChild variant="outline">
              <a href={data.stripeInvoiceUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="mr-1.5 h-4 w-4" aria-hidden />
                {ts.viewInvoice}
              </a>
            </Button>
          )}
          {data.stripeInvoicePdf && (
            <Button asChild variant="outline">
              <a href={data.stripeInvoicePdf} target="_blank" rel="noopener noreferrer">
                <FileText className="mr-1.5 h-4 w-4" aria-hidden />
                {ts.downloadPdf}
              </a>
            </Button>
          )}
          <Button onClick={() => void download()} disabled={csv.isPending}>
            {csv.isPending ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Download className="mr-1.5 h-4 w-4" aria-hidden />
            )}
            {ts.downloadCsv}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label={ts.resale} value={money(data.totalResale)} />
        <StatCard label={ts.due} value={money(data.totalDue)} />
        <StatCard
          label={ts.margin}
          value={money(data.totalMargin)}
          tone={data.totalMargin.startsWith('-') ? 'negative' : 'positive'}
        />
      </div>

      <section aria-label={ts.lines} className="space-y-2">
        <h2 className="text-sm font-semibold">{ts.lines}</h2>
        {data.lines.length === 0 ? (
          <EmptyBlock icon={FileText} title={ts.noLines} />
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{ts.line.workspace}</TableHead>
                  <TableHead className="text-right">{ts.line.days}</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">{ts.line.seats}</TableHead>
                  <TableHead className="text-right">{ts.line.resale}</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">{ts.line.share}</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">{ts.line.minimum}</TableHead>
                  <TableHead className="hidden text-right lg:table-cell">{ts.line.extraCredits}</TableHead>
                  <TableHead className="text-right">{ts.line.due}</TableHead>
                  <TableHead className="text-right">{ts.line.margin}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.lines.map((line) => (
                  <TableRow key={line.workspaceId}>
                    <TableCell className="font-medium">
                      <Link href={`/partner/workspaces/${line.workspaceId}`} className="hover:underline">
                        {line.workspaceName}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {format(ts.daysOfPeriod, { days: line.daysActive, total: line.daysInPeriod })}
                    </TableCell>
                    <TableCell className="hidden text-right tabular-nums sm:table-cell">{line.seatsBilled || t.partner.common.dash}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(line.resale)}</TableCell>
                    <TableCell className="hidden text-right tabular-nums lg:table-cell">{money(line.shareAmount)}</TableCell>
                    <TableCell className="hidden text-right tabular-nums lg:table-cell">
                      {money(addMoney(line.floorAmount, line.creditFloorAmount))}
                    </TableCell>
                    <TableCell className="hidden text-right tabular-nums lg:table-cell">{money(line.extraCreditsAmount)}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{money(line.due)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(line.margin)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}

/** Sum two decimal money strings exactly (cents), without floating point. */
function addMoney(a: string, b: string): string {
  return fromCents(toCents(a) + toCents(b));
}
