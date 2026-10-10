/**
 * Statements: the live preview of this month and the past monthly statements
 * WeldSuite has invoiced.
 */

import { FileText } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { usePartnerStatements } from '@/hooks/queries/use-partner-queries';
import { useI18n } from '@/lib/i18n/provider';
import { usePartnerContext } from '@/lib/partner/partner-context';
import { Link } from '@/lib/router';
import {
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
  PageHeader,
  StatementStatusBadge,
  errorText,
  useFormatters,
} from '../components/kit';

export default function PartnerStatementsPage() {
  const { t, format } = useI18n();
  const ts = t.partner.statements;
  const f = useFormatters();
  const { can } = usePartnerContext();
  const allowed = can('partner:billing:read');
  const { data, isLoading, error, refetch } = usePartnerStatements(allowed);

  if (!allowed) {
    return (
      <>
        <PageHeader title={ts.title} description={ts.description} />
        <EmptyBlock icon={FileText} title={ts.noBillingAccess} />
      </>
    );
  }

  const statements = data ?? [];
  const preview = statements.find((s) => s.id === null);
  const past = statements.filter((s) => s.id !== null);

  let body;
  if (isLoading) body = <LoadingBlock />;
  else if (error) body = <ErrorBlock message={errorText(error, t.partner.common.loadFailed)} onRetry={() => void refetch()} />;
  else
    body = (
      <div className="space-y-8">
        {preview && (
          <section aria-label={ts.currentMonth} className="space-y-2">
            <h2 className="text-sm font-semibold">{ts.currentMonth}</h2>
            <Card>
              <CardContent className="flex flex-wrap items-center justify-between gap-4 p-5">
                <div className="min-w-0">
                  <p className="font-medium">{f.month(preview.periodStart)}</p>
                  <p className="text-sm text-muted-foreground">{ts.previewNote}</p>
                </div>
                <dl className="flex flex-wrap items-center gap-x-8 gap-y-2 text-sm">
                  <div>
                    <dt className="text-muted-foreground">{ts.resale}</dt>
                    <dd className="tabular-nums">{f.money(preview.totalResale, preview.currency)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{ts.due}</dt>
                    <dd className="font-medium tabular-nums">{f.money(preview.totalDue, preview.currency)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{ts.margin}</dt>
                    <dd className="tabular-nums">{f.money(preview.totalMargin, preview.currency)}</dd>
                  </div>
                </dl>
                <Button asChild variant="outline" size="sm">
                  <Link href="/partner/statements/current">{ts.open}</Link>
                </Button>
              </CardContent>
            </Card>
          </section>
        )}

        <section aria-label={ts.pastStatements} className="space-y-2">
          <h2 className="text-sm font-semibold">{ts.pastStatements}</h2>
          {past.length === 0 ? (
            <EmptyBlock icon={FileText} title={ts.emptyTitle} description={ts.emptyDescription} />
          ) : (
            <div className="overflow-x-auto rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{ts.period}</TableHead>
                    <TableHead>{ts.status}</TableHead>
                    <TableHead className="hidden text-right md:table-cell">{ts.resale}</TableHead>
                    <TableHead className="text-right">{ts.due}</TableHead>
                    <TableHead className="hidden text-right md:table-cell">{ts.margin}</TableHead>
                    <TableHead className="hidden lg:table-cell" />
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {past.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-medium">{f.month(s.periodStart)}</TableCell>
                      <TableCell>
                        <StatementStatusBadge status={s.status} />
                      </TableCell>
                      <TableCell className="hidden text-right tabular-nums md:table-cell">
                        {f.money(s.totalResale, s.currency)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{f.money(s.totalDue, s.currency)}</TableCell>
                      <TableCell className="hidden text-right tabular-nums md:table-cell">
                        {f.money(s.totalMargin, s.currency)}
                      </TableCell>
                      <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">
                        {s.paidAt
                          ? format(ts.paidOn, { date: f.date(s.paidAt) })
                          : s.dueAt
                            ? format(ts.dueDate, { date: f.date(s.dueAt) })
                            : ''}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button asChild variant="ghost" size="sm">
                          <Link href={`/partner/statements/${s.id}`}>{ts.open}</Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>
      </div>
    );

  return (
    <>
      <PageHeader title={ts.title} description={ts.description} />
      {body}
    </>
  );
}
