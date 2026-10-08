import { Badge } from '@weldsuite/ui/components/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import type { PaymentRunDetail } from '@/lib/api/domains/weldbooks-payment-runs';
import { CheckStatusBadge } from './run-badges';

/** The vendors a run pays, what each gets and what became of it, then the bills behind the amounts. */
export function RunBillsCard({ run }: Readonly<{ run: PaymentRunDetail }>) {
  const { t } = useI18n();
  const tp = t.weldbooksUs.payments;
  const tv = tp.detail.vendors;
  const { formatMoney, formatDate } = useWeldbooksFormat();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{tv.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tv.columns.vendor}</TableHead>
                <TableHead className="text-right">{tv.columns.bills}</TableHead>
                <TableHead>{tv.columns.status}</TableHead>
                <TableHead className="text-right">{tv.columns.amount}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {run.vendors.map((vendor) => (
                <TableRow key={vendor.partyId}>
                  <TableCell className="font-medium">
                    {vendor.name}
                    {vendor.backupWithholding ? (
                      <p className="text-xs font-normal text-muted-foreground">
                        {tv.withholdingLine
                          .replace('{rate}', String(Math.round(vendor.backupWithholding.rate * 100)))
                          .replace('{withheld}', formatMoney(vendor.backupWithholding.amount))
                          .replace('{net}', formatMoney(vendor.backupWithholding.net))}
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{vendor.billCount}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      {vendor.held ? <Badge variant="warning">{tv.held}</Badge> : null}
                      {vendor.payment ? (
                        run.method === 'check' && vendor.payment.checkNumber ? (
                          <>
                            <span className="tabular-nums">{tv.checkNumber.replace('{number}', vendor.payment.checkNumber)}</span>
                            {vendor.payment.checkStatus ? <CheckStatusBadge status={vendor.payment.checkStatus} /> : null}
                          </>
                        ) : (
                          <Badge variant={vendor.payment.deleted ? 'outline' : 'success'}>
                            {vendor.payment.deleted ? tv.paymentVoided : tv.paymentMade}
                          </Badge>
                        )
                      ) : !vendor.held ? (
                        <span className="text-muted-foreground">{tv.notPaidYet}</span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{formatMoney(vendor.amount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tv.columns.bill}</TableHead>
                <TableHead>{tv.columns.vendor}</TableHead>
                <TableHead>{tv.columns.due}</TableHead>
                <TableHead className="text-right">{tv.columns.balance}</TableHead>
                <TableHead className="text-right">{tv.columns.paying}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {run.items.map((item) => (
                <TableRow key={item.billId}>
                  <TableCell className="font-medium">{item.billNumber ?? item.billId}</TableCell>
                  <TableCell>{item.partyName}</TableCell>
                  <TableCell className="whitespace-nowrap">{item.dueDate ? formatDate(item.dueDate) : '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{item.balanceDue ? formatMoney(item.balanceDue) : '—'}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{formatMoney(item.amount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
