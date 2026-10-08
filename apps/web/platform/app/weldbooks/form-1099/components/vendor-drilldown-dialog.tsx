import { Link } from '@tanstack/react-router';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useForm1099VendorDetail } from '@/hooks/queries/use-weldbooks-1099-queries';
import type { DrillDownDocumentRefs } from '@/lib/api/domains/weldbooks-1099';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { STATUS_VARIANT, boxTag } from '../form-1099-model';

interface VendorDrilldownDialogProps {
  partyId: string | null;
  year: number;
  onOpenChange: (open: boolean) => void;
}

function toNumber(value: string | number | null | undefined): number {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Where a row of the drill-down came from: the payment or bank line, and the bill and line it paid. */
function Source({ refs }: Readonly<{ refs: DrillDownDocumentRefs }>) {
  const { t } = useI18n();
  const td = t.weldbooksUs.form1099.drilldown;
  const { formatDate } = useWeldbooksFormat();
  const { payment, bill, billLine, bankTransaction } = refs;
  return (
    <div className="space-y-0.5 text-xs">
      {payment ? (
        <p>
          {td.payment.replace('{date}', formatDate(payment.date))}
          {payment.method ? ` · ${payment.method.replaceAll('_', ' ')}` : ''}
          {payment.checkNumber ? ` · #${payment.checkNumber}` : ''}
          {payment.reference ? ` · ${payment.reference}` : ''}
        </p>
      ) : null}
      {bankTransaction ? (
        <p>
          {td.bankLine.replace('{date}', formatDate(bankTransaction.date))}
          {bankTransaction.description ? ` · ${bankTransaction.description}` : ''}
          {bankTransaction.checkNumber ? ` · #${bankTransaction.checkNumber}` : ''}
        </p>
      ) : null}
      {bill ? (
        <p className="text-muted-foreground">
          <Link to="/weldbooks/bills/$id" params={{ id: bill.id }} className="hover:underline">
            {td.bill.replace('{number}', bill.number ?? bill.reference ?? bill.id)}
          </Link>
          {billLine?.account ? ` · ${billLine.account.code} ${billLine.account.name}` : ''}
          {billLine?.description ? ` · ${billLine.description}` : ''}
        </p>
      ) : null}
    </div>
  );
}

/** The payments and bank lines behind a vendor's boxes, what was left out and why, and what has no box yet. */
export function VendorDrilldownDialog({ partyId, year, onOpenChange }: Readonly<VendorDrilldownDialogProps>) {
  const { t } = useI18n();
  const td = t.weldbooksUs.form1099.drilldown;
  const { formatMoney } = useWeldbooksFormat();
  const query = useForm1099VendorDetail(partyId, year);
  const detail = query.data;

  return (
    <Dialog open={partyId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{detail ? detail.vendor.name : td.title}</DialogTitle>
          <DialogDescription>{td.description.replace('{year}', String(year))}</DialogDescription>
        </DialogHeader>

        {query.isLoading ? (
          <p className="text-sm text-muted-foreground">{td.loading}</p>
        ) : query.isError ? (
          <div className="space-y-2" role="alert">
            <p className="text-sm text-destructive">{td.loadFailed}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>
              {td.retry}
            </Button>
          </div>
        ) : detail ? (
          <div className="max-h-[60vh] space-y-5 overflow-y-auto pr-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={STATUS_VARIANT[detail.vendor.status]}>{t.weldbooksUs.form1099.vendorStatus[detail.vendor.status]}</Badge>
              {detail.vendor.reasons.map((reason) => (
                <span key={reason} className="text-xs text-muted-foreground">
                  {reason}
                </span>
              ))}
            </div>

            <section aria-labelledby="drill-contributions">
              <h3 id="drill-contributions" className="mb-1 text-sm font-medium">
                {td.contributions}
              </h3>
              {detail.contributions.length === 0 ? (
                <p className="text-sm text-muted-foreground">{td.noContributions}</p>
              ) : (
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{td.colSource}</TableHead>
                        <TableHead>{td.colBox}</TableHead>
                        <TableHead>{td.colBoxFrom}</TableHead>
                        <TableHead className="text-right">{td.colAmount}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detail.contributions.map((row, index) => (
                        <TableRow key={`${row.payment?.id ?? row.bankTransaction?.id ?? 'x'}-${row.box}-${index}`}>
                          <TableCell>
                            <Source refs={row} />
                            {row.unapplied ? <p className="text-xs text-muted-foreground">{td.unapplied}</p> : null}
                          </TableCell>
                          <TableCell>{boxTag(row.box)}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{td.boxSources[row.boxSource]}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatMoney(row.amount)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </section>

            {detail.exclusions.length > 0 ? (
              <section aria-labelledby="drill-exclusions">
                <h3 id="drill-exclusions" className="mb-1 text-sm font-medium">
                  {td.exclusions}
                </h3>
                <p className="mb-1 text-xs text-muted-foreground">{td.exclusionsHelp}</p>
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableBody>
                      {detail.exclusions.map((row, index) => (
                        <TableRow key={`${row.payment?.id ?? row.bankTransaction?.id ?? 'x'}-${index}`}>
                          <TableCell>
                            <Source refs={row} />
                          </TableCell>
                          <TableCell className="text-sm">{td.exclusionReasons[row.reason]}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatMoney(row.amount)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </section>
            ) : null}

            {detail.unmapped.length > 0 ? (
              <section aria-labelledby="drill-unmapped">
                <h3 id="drill-unmapped" className="mb-1 text-sm font-medium text-amber-600 dark:text-amber-400">
                  {td.unmapped}
                </h3>
                <p className="mb-1 text-xs text-muted-foreground">{td.unmappedHelp}</p>
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableBody>
                      {detail.unmapped.map((row, index) => (
                        <TableRow key={`${row.payment?.id ?? row.bankTransaction?.id ?? 'x'}-${index}`}>
                          <TableCell>
                            <Source refs={row} />
                          </TableCell>
                          <TableCell className="text-sm">{td.unmappedReasons[row.reason]}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatMoney(toNumber(row.amount))}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </section>
            ) : null}

            {detail.adjustments.length > 0 ? (
              <section aria-labelledby="drill-adjustments">
                <h3 id="drill-adjustments" className="mb-1 text-sm font-medium">
                  {td.adjustments}
                </h3>
                <ul className="space-y-1 text-sm">
                  {detail.adjustments.map((adjustment, index) => (
                    <li key={`${adjustment.box}-${index}`} className="flex flex-wrap justify-between gap-2">
                      <span>
                        {boxTag(adjustment.box)} · <span className="text-muted-foreground">{adjustment.reason}</span>
                      </span>
                      <span className="tabular-nums">{formatMoney(adjustment.amount)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          {partyId ? (
            <Button asChild variant="outline">
              <Link to="/weldbooks/customers/$id" params={{ id: partyId }}>
                {td.openVendor}
              </Link>
            </Button>
          ) : null}
          <Button type="button" onClick={() => onOpenChange(false)}>
            {td.close}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
