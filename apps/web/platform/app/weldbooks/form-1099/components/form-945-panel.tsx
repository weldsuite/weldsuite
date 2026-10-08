import { Link } from '@tanstack/react-router';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useForm945 } from '@/hooks/queries/use-weldbooks-1099-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

interface Form945PanelProps {
  year: number;
  enabled: boolean;
}

const MONTH_FORMAT: Intl.DateTimeFormatOptions = { month: 'long', timeZone: 'UTC' };

/** Backup withholding of the year as Form 945 wants it: the total (line 2), per month with deposit due dates, and per vendor. */
export function Form945Panel({ year, enabled }: Readonly<Form945PanelProps>) {
  const { t, language } = useI18n();
  const tf = t.weldbooksUs.form1099.form945;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const query = useForm945(year, { enabled });

  if (query.isLoading) return <p className="text-sm text-muted-foreground">{tf.loading}</p>;
  if (query.isError || !query.data) {
    return (
      <div className="space-y-2" role="alert">
        <p className="text-sm text-destructive">{tf.loadFailed}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>
          {tf.retry}
        </Button>
      </div>
    );
  }

  const data = query.data;
  const monthName = (month: number) => new Intl.DateTimeFormat(language || 'en', MONTH_FORMAT).format(new Date(Date.UTC(2000, month - 1, 1)));

  if (data.backupWithholding === 0) {
    return (
      <div className="rounded-md border p-8 text-center text-sm text-muted-foreground" data-testid="form945-empty">
        <p>{tf.empty.replace('{year}', String(year))}</p>
        <p className="mt-1">{tf.emptyHelp}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted-foreground">{tf.intro}</p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="space-y-1 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{tf.line2}</p>
            <p className="text-2xl font-semibold tabular-nums" data-testid="form945-total">
              {formatMoney(data.backupWithholding)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-1 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{tf.line3}</p>
            <p className="text-2xl font-semibold tabular-nums">{formatMoney(data.totalTaxes)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-1 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{tf.dueDate}</p>
            <p className="text-2xl font-semibold">{formatDate(data.dueDate)}</p>
          </CardContent>
        </Card>
      </div>

      <section aria-labelledby="form945-months">
        <h2 id="form945-months" className="mb-2 text-sm font-medium">
          {tf.byMonth}
        </h2>
        <p className="mb-2 text-xs text-muted-foreground">{tf.depositNote}</p>
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tf.colMonth}</TableHead>
                <TableHead className="text-right">{tf.colLiability}</TableHead>
                <TableHead>{tf.colDeposit}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.months.map((month) => (
                <TableRow key={month.month} className={month.amount === 0 ? 'text-muted-foreground' : undefined}>
                  <TableCell>{monthName(month.month)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(month.amount)}</TableCell>
                  <TableCell>{month.amount === 0 ? '—' : formatDate(month.depositDue)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section aria-labelledby="form945-vendors">
        <h2 id="form945-vendors" className="mb-2 text-sm font-medium">
          {tf.byVendor}
        </h2>
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tf.colVendor}</TableHead>
                <TableHead className="text-right">{tf.colWithheld}</TableHead>
                <TableHead className="text-right">{tf.colPayments}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.byVendor.map((vendor) => (
                <TableRow key={vendor.partyId}>
                  <TableCell>
                    <Link to="/weldbooks/customers/$id" params={{ id: vendor.partyId }} className="hover:underline">
                      {vendor.name ?? vendor.partyId}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(vendor.amount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{vendor.paymentIds.length}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}
