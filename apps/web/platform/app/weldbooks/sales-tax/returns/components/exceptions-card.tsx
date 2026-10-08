import { useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { CircleCheck, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useI18n } from '@/lib/i18n/provider';
import {
  useAmendTaxReturn,
  useCarryForwardExceptions,
  useReturnExceptions,
} from '@/hooks/queries/use-weldbooks-sales-tax-center-queries';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import type { ExceptionItem, ReturnExceptions, TaxReturnDetail } from '@/lib/api/domains/weldbooks-sales-tax-center';
import { DocumentLink } from '../../shared/document-link';
import { EmptyState, ErrorState, RowsSkeleton } from '../../shared/query-states';
import { Notice } from '../../shared/notice';
import { fill } from '../../shared/text';

/** An exception row that is still waiting for a decision. */
export function isOpenException(item: Pick<ExceptionItem, 'resolution'>): boolean {
  return item.resolution === 'open' || item.resolution === 'partial';
}

/** The tax line ids behind the selected exception rows. */
export function selectedTaxLineIds(items: readonly ExceptionItem[], selected: ReadonlySet<string>): string[] {
  return items.filter((item) => selected.has(item.key) && isOpenException(item)).flatMap((item) => item.taxLineIds);
}

interface ExceptionsCardProps {
  ret: TaxReturnDetail;
  canCarryForward: boolean;
  canAmend: boolean;
}

const RESOLUTION_VARIANT = {
  open: 'warning',
  partial: 'warning',
  carried_forward: 'secondary',
  amended: 'success',
} as const;

/** What changed in the filed period after filing, and the choice: carry the rows forward or amend the return. */
export function ExceptionsCard({ ret, canCarryForward, canAmend }: Readonly<ExceptionsCardProps>) {
  const { t } = useI18n();
  const te = t.weldbooksUs.salesTax.center.returnPage.exceptions;
  const { formatMoney, formatDate, formatDateTime } = useWeldbooksFormat();
  const navigate = useNavigate();
  const filed = ret.status === 'filed' || ret.status === 'paid';
  const query = useReturnExceptions(ret.id, { enabled: filed });
  const carry = useCarryForwardExceptions(ret.id);
  const amend = useAmendTaxReturn(ret.id);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [amendOpen, setAmendOpen] = useState(false);
  const [recalculate, setRecalculate] = useState<Array<{ id: string; status: string; periodEnd: string }>>([]);

  const data: ReturnExceptions | undefined = query.data;
  const items = useMemo(() => data?.items ?? [], [data]);
  const openItems = items.filter(isOpenException);
  const resolutions = te.resolutions as Record<string, string>;
  const alreadyAmended = ret.amendments.length > 0;

  const toggle = (key: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const allSelected = openItems.length > 0 && openItems.every((item) => selected.has(item.key));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(openItems.map((item) => item.key)));

  const carryRows = async (taxLineIds?: string[]) => {
    try {
      const result = await carry.mutateAsync(taxLineIds);
      toast.success(fill(te.carried, { count: result.carriedRows, tax: formatMoney(result.taxAmount) }));
      setSelected(new Set());
      setRecalculate(result.recalculate);
    } catch (err) {
      toast.error(te.carryFailed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  const amendReturn = async () => {
    try {
      const created = await amend.mutateAsync();
      toast.success(te.amended);
      setAmendOpen(false);
      await navigate({ to: '/weldbooks/sales-tax/returns/$id', params: { id: created.id } });
    } catch (err) {
      toast.error(te.amendFailed, { description: err instanceof Error ? err.message : undefined });
      setAmendOpen(false);
    }
  };

  const selectedIds = selectedTaxLineIds(items, selected);

  return (
    <Card data-testid="exceptions-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{te.title}</CardTitle>
        <p className="text-xs text-muted-foreground">{te.description}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {!filed ? (
          <p className="text-sm text-muted-foreground">{te.notFiled}</p>
        ) : query.isLoading ? (
          <RowsSkeleton rows={3} />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : data && items.length === 0 && data.latePayments.length === 0 ? (
          <EmptyState icon={CircleCheck} title={te.none} description={te.noneDescription} />
        ) : data ? (
          <>
            <div className="flex flex-wrap gap-2 text-sm">
              {(['open', 'carried_forward', 'amended'] as const).map((key) => (
                <Badge key={key} variant={RESOLUTION_VARIANT[key]} data-testid={`exceptions-total-${key}`}>
                  {(te.totals as Record<string, string>)[key]}:{' '}
                  {fill(data.totals[key].documents === 1 ? te.documentsAndTaxOne : te.documentsAndTaxMany, {
                    documents: data.totals[key].documents,
                    tax: formatMoney(data.totals[key].taxAmount),
                  })}
                </Badge>
              ))}
            </div>

            {items.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">
                      {canCarryForward && openItems.length > 0 ? (
                        <Checkbox checked={allSelected} onCheckedChange={toggleAll} aria-label={te.selectAll} />
                      ) : null}
                    </TableHead>
                    <TableHead>{te.document}</TableHead>
                    <TableHead>{te.taxDate}</TableHead>
                    <TableHead>{te.postedAt}</TableHead>
                    <TableHead className="text-right">{te.grossSales}</TableHead>
                    <TableHead className="text-right">{te.taxableSales}</TableHead>
                    <TableHead className="text-right">{te.tax}</TableHead>
                    <TableHead>{te.resolution}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => {
                    const documentLabel = item.document.number ?? t.weldbooksUs.salesTax.center.documentTypes.invoice;
                    return (
                      <TableRow key={item.key} data-testid="exception-row">
                        <TableCell className="w-8">
                          {canCarryForward && isOpenException(item) ? (
                            <Checkbox
                              checked={selected.has(item.key)}
                              onCheckedChange={() => toggle(item.key)}
                              aria-label={fill(te.selectRow, { document: documentLabel })}
                            />
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <DocumentLink type={item.document.type} id={item.document.id} number={item.document.number} />
                          {item.document.contactName ? (
                            <span className="block text-xs text-muted-foreground">{item.document.contactName}</span>
                          ) : null}
                        </TableCell>
                        <TableCell>{formatDate(item.taxDate)}</TableCell>
                        <TableCell>{formatDateTime(item.postedAt)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(item.grossAmount)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(item.taxableAmount)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(item.taxAmount)}</TableCell>
                        <TableCell>
                          <Badge variant={RESOLUTION_VARIANT[item.resolution]}>{resolutions[item.resolution]}</Badge>
                          {item.amendedByReturnId ? (
                            <span className="mt-1 block text-xs text-muted-foreground">
                              {te.amendedBy}{' '}
                              <Link
                                to="/weldbooks/sales-tax/returns/$id"
                                params={{ id: item.amendedByReturnId }}
                                className="text-primary hover:underline"
                              >
                                {t.weldbooksUs.salesTax.center.returnPage.amendments.item}
                              </Link>
                            </span>
                          ) : null}
                          {item.countedByReturnId ? (
                            <span className="mt-1 block text-xs text-muted-foreground">
                              {te.countedBy}{' '}
                              <Link
                                to="/weldbooks/sales-tax/returns/$id"
                                params={{ id: item.countedByReturnId }}
                                className="text-primary hover:underline"
                              >
                                {te.returnLink}
                              </Link>
                            </span>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            ) : null}

            {data.latePayments.length > 0 ? (
              <div className="space-y-2" data-testid="late-payments">
                <h3 className="text-sm font-medium">{te.latePaymentsTitle}</h3>
                <p className="text-xs text-muted-foreground">{te.latePaymentsDescription}</p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{te.invoice}</TableHead>
                      <TableHead>{te.customer}</TableHead>
                      <TableHead className="text-right">{te.amount}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.latePayments.map((payment) => (
                      <TableRow key={payment.invoiceId}>
                        <TableCell>
                          <DocumentLink type="invoice" id={payment.invoiceId} number={payment.invoiceNumber} />
                        </TableCell>
                        <TableCell>{payment.contactName ?? '—'}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(payment.amount)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : null}

            {recalculate.length > 0 ? (
              <Notice tone="info" data-testid="recalculate-note">
                <p>{te.recalculateNote}</p>
                <ul className="list-disc pl-5">
                  {recalculate.map((later) => (
                    <li key={later.id}>
                      <Link
                        to="/weldbooks/sales-tax/returns/$id"
                        params={{ id: later.id }}
                        className="font-medium underline underline-offset-2"
                      >
                        {formatDate(later.periodEnd)}
                      </Link>
                    </li>
                  ))}
                </ul>
              </Notice>
            ) : null}

            {alreadyAmended ? (
              <Notice tone="info">
                <p>{te.alreadyAmended}</p>
              </Notice>
            ) : null}

            {canCarryForward || canAmend ? (
              <div className="flex flex-wrap items-center gap-2">
                {canCarryForward && openItems.length > 0 ? (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void carryRows(selectedIds)}
                      disabled={selectedIds.length === 0 || carry.isPending}
                    >
                      {carry.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                      {te.carrySelected}
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => void carryRows()} disabled={carry.isPending}>
                      {te.carryAll}
                    </Button>
                    {selected.size > 0 ? (
                      <span className="text-xs text-muted-foreground">{fill(te.selected, { count: selected.size })}</span>
                    ) : null}
                  </>
                ) : null}
                {canAmend && !alreadyAmended ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => setAmendOpen(true)}>
                    {te.amend}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </CardContent>

      <ConfirmDialog
        open={amendOpen}
        onOpenChange={setAmendOpen}
        title={te.amendConfirm.title}
        description={te.amendConfirm.description}
        confirmLabel={te.amendConfirm.confirm}
        cancelLabel={t.weldbooksUs.salesTax.center.common.cancel}
        loading={amend.isPending}
        onConfirm={amendReturn}
      />
    </Card>
  );
}
