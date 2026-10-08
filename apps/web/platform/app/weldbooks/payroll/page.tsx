import { useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { FileUp, Plug, Users } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { PageLoader } from '@/components/page-loader';
import { usePayrollImports } from '@/hooks/queries/use-weldbooks-assets-queries';
import type { PayrollImport } from '@/lib/api/domains/weldbooks-assets';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { fill } from '../fixed-assets/text';
import { ReversePayrollDialog } from './components/reverse-dialog';

const PAGE_SIZE = 25;
const ALL = 'all';

/** The two amounts a payroll is known by: gross wages and net pay (a ledger export has neither, so they are left out). */
function headline(summary: PayrollImport['summary']): { gross: number | null; net: number | null } {
  return { gross: summary?.gross_wages ?? null, net: summary?.net_pay ?? null };
}

/** Payrolls imported into the ledger, from a CSV file or from Gusto. */
export default function PayrollImportsPage() {
  const { t } = useI18n();
  const tp = t.weldbooksUs.assets.payroll;
  const tl = tp.list;
  const common = t.weldbooksUs.assets.common;
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { formatMoney, formatDate } = useWeldbooksFormat();

  const [status, setStatus] = useState(ALL);
  const [source, setSource] = useState(ALL);
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const [reversing, setReversing] = useState<PayrollImport | null>(null);

  const filters = useMemo(
    () => ({
      limit: PAGE_SIZE,
      status: status === ALL ? undefined : (status as 'posted' | 'reversed'),
      source: source === ALL ? undefined : (source as 'csv' | 'gusto'),
      cursor,
    }),
    [status, source, cursor],
  );
  const { data, isLoading, isError, refetch } = usePayrollImports(filters);
  const imports = data?.data ?? [];
  const filtered = status !== ALL || source !== ALL;

  const openImport = (id: string) => void navigate({ to: '/weldbooks/payroll/$id', params: { id } });

  let body: React.ReactNode;
  if (isLoading) {
    body = <PageLoader fullScreen={false} />;
  } else if (isError) {
    body = (
      <Card>
        <CardContent className="space-y-3 py-10 text-center">
          <p className="text-sm text-destructive" role="alert">
            {tl.loadFailed}
          </p>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            {common.retry}
          </Button>
        </CardContent>
      </Card>
    );
  } else if (imports.length === 0) {
    body = (
      <Card>
        <CardContent className="space-y-3 py-10 text-center">
          <Users className="mx-auto h-10 w-10 text-muted-foreground" aria-hidden />
          <p className="font-medium">{filtered ? tl.emptyFiltered : tl.emptyTitle}</p>
          {!filtered ? <p className="text-sm text-muted-foreground">{tl.emptyDescription}</p> : null}
          {!filtered && can('journal:create') ? (
            <Button asChild>
              <Link to="/weldbooks/payroll/import">{tl.importCsv}</Link>
            </Button>
          ) : null}
        </CardContent>
      </Card>
    );
  } else {
    body = (
      <>
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tl.columns.payDate}</TableHead>
                <TableHead>{tl.columns.period}</TableHead>
                <TableHead>{tl.columns.source}</TableHead>
                <TableHead className="text-right">{tl.columns.grossWages}</TableHead>
                <TableHead className="text-right">{tl.columns.netPay}</TableHead>
                <TableHead>{tl.columns.status}</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">{tl.columns.actions}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {imports.map((row) => {
                const { gross, net } = headline(row.summary);
                return (
                  <TableRow
                    key={row.id}
                    className="cursor-pointer"
                    tabIndex={0}
                    data-testid={`payroll-row-${row.id}`}
                    onClick={() => openImport(row.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') openImport(row.id);
                    }}
                  >
                    <TableCell className="whitespace-nowrap font-medium">{formatDate(row.payDate)}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {row.periodStart && row.periodEnd ? `${formatDate(row.periodStart)} – ${formatDate(row.periodEnd)}` : '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{tp.sources[row.source]}</Badge>
                      {row.sourceFileName ? <span className="ml-2 text-xs text-muted-foreground">{row.sourceFileName}</span> : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{gross === null ? '—' : formatMoney(gross)}</TableCell>
                    <TableCell className="text-right tabular-nums">{net === null ? '—' : formatMoney(net)}</TableCell>
                    <TableCell>
                      <Badge variant={row.status === 'posted' ? 'success' : 'secondary'}>{tp.statuses[row.status]}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {row.status === 'posted' && can('journal:delete') ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(event) => {
                            event.stopPropagation();
                            setReversing(row);
                          }}
                        >
                          {tl.reverse}
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{fill(tl.count, { count: data?.pagination.totalCount ?? imports.length })}</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={cursors.length === 0} onClick={() => setCursors((current) => current.slice(0, -1))}>
              {common.newer}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!data?.pagination.hasMore || !data.pagination.cursor}
              onClick={() => {
                const next = data?.pagination.cursor;
                if (next) setCursors((current) => [...current, next]);
              }}
            >
              {common.older}
            </Button>
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{tl.title}</h1>
          <p className="text-sm text-muted-foreground">{tl.subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" asChild>
            <Link to="/weldbooks/payroll/connections">
              <Plug className="h-4 w-4" />
              {tl.gusto}
            </Link>
          </Button>
          {can('journal:create') ? (
            <Button asChild>
              <Link to="/weldbooks/payroll/import">
                <FileUp className="h-4 w-4" />
                {tl.importCsv}
              </Link>
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-44 space-y-1">
          <Label htmlFor="payroll-filter-status" className="text-xs text-muted-foreground">
            {tl.columns.status}
          </Label>
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value);
              setCursors([]);
            }}
          >
            <SelectTrigger id="payroll-filter-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{tl.allStatuses}</SelectItem>
              <SelectItem value="posted">{tp.statuses.posted}</SelectItem>
              <SelectItem value="reversed">{tp.statuses.reversed}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="w-44 space-y-1">
          <Label htmlFor="payroll-filter-source" className="text-xs text-muted-foreground">
            {tl.columns.source}
          </Label>
          <Select
            value={source}
            onValueChange={(value) => {
              setSource(value);
              setCursors([]);
            }}
          >
            <SelectTrigger id="payroll-filter-source">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{tl.allSources}</SelectItem>
              <SelectItem value="csv">{tp.sources.csv}</SelectItem>
              <SelectItem value="gusto">{tp.sources.gusto}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {body}

      {reversing ? (
        <ReversePayrollDialog payroll={reversing} open onOpenChange={(open) => (open ? undefined : setReversing(null))} />
      ) : null}
    </div>
  );
}
