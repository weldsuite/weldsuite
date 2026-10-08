import type { ReactNode } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, ExternalLink, MapPin } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { useI18n } from '@/lib/i18n/provider';
import { useNexusDetail } from '@/hooks/queries/use-weldbooks-sales-tax-center-queries';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { isSalesTaxRequestError, type NexusDetail } from '@/lib/api/domains/weldbooks-sales-tax-center';
import { Notice } from '../../shared/notice';
import { EmptyState, ErrorState } from '../../shared/query-states';
import { SalesTaxGate } from '../../shared/sales-tax-frame';
import { RegisterStateLink } from '../../shared/setup-links';
import { fill } from '../../shared/text';
import { MonthlyChart } from '../monthly-chart';
import { alertVariant, statusVariant } from '../nexus-model';
import { NexusProgressBar } from '../nexus-progress-bar';

function Field({ label, children, testId }: Readonly<{ label: string; children: ReactNode; testId?: string }>) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium" data-testid={testId}>
        {children}
      </dd>
    </div>
  );
}

function DetailSkeleton() {
  const { t } = useI18n();
  return (
    <div className="space-y-4" role="status" aria-label={t.weldbooksUs.salesTax.center.common.loading}>
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

function NexusDetailView({ detail }: Readonly<{ detail: NexusDetail }>) {
  const { t } = useI18n();
  const tn = t.weldbooksUs.salesTax.center.nexus;
  const td = tn.detail;
  const agencyStatuses = t.weldbooksUs.salesTax.center.agencyStatuses as Record<string, string>;
  const { can } = usePermissions();
  const { formatMoney, formatDate, formatMonth } = useWeldbooksFormat();
  const alerts = tn.alerts as Record<string, string>;
  const statuses = tn.statuses as Record<string, string>;
  const { rule } = detail;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold">{fill(td.title, { name: detail.stateName })}</h1>
            <Badge variant={alertVariant(detail.alert)}>{alerts[detail.alert]}</Badge>
            <Badge variant={statusVariant(detail.status, detail.registered)}>{statuses[detail.status]}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {detail.registered
              ? tn.registeredYes
              : detail.agencyStatus
                ? `${td.agencyStatus}: ${agencyStatuses[detail.agencyStatus] ?? detail.agencyStatus}`
                : td.noAgency}
          </p>
        </div>
        {detail.alert === 'register' && can('taxes:create') ? (
          <Button asChild>
            <RegisterStateLink stateCode={detail.stateCode}>{tn.register}</RegisterStateLink>
          </Button>
        ) : null}
      </div>

      {detail.pending ? (
        <Notice tone="warning" title={td.pendingTitle} data-testid="nexus-pending">
          <p>{fill(tn.pending, { date: formatDate(detail.pending.collectFrom), crossed: formatDate(detail.pending.exceededOn) })}</p>
        </Notice>
      ) : null}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{td.measurement}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <NexusProgressBar row={detail} />
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={td.salesAgainstThreshold} testId="nexus-sales">
              {detail.thresholdSales === null
                ? formatMoney(detail.salesTotal)
                : fill(tn.ofThreshold, { amount: formatMoney(detail.salesTotal), threshold: formatMoney(detail.thresholdSales) })}
            </Field>
            <Field label={td.transactionsAgainstThreshold} testId="nexus-transactions">
              {detail.thresholdTransactions === null
                ? tn.noTransactionTest
                : fill(tn.transactionsOf, { count: detail.transactionCount, threshold: detail.thresholdTransactions })}
            </Field>
            <Field label={td.measurementWindow}>
              {fill(t.weldbooksUs.salesTax.center.overview.periodRange, {
                start: formatDate(detail.window.from),
                end: formatDate(detail.window.to),
              })}
            </Field>
            <Field label={td.exceededOn}>{detail.exceededOn ? formatDate(detail.exceededOn) : '—'}</Field>
            <Field label={td.collectFrom}>
              {detail.collectFrom ? formatDate(detail.collectFrom) : '—'}
              {detail.collectFrom && !detail.collectFromVerified ? (
                <span className="block text-xs font-normal text-muted-foreground">{td.collectNotConfirmed}</span>
              ) : null}
            </Field>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{td.periodsTitle}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{td.period}</TableHead>
                <TableHead>{td.role}</TableHead>
                <TableHead className="text-right">{td.salesColumn}</TableHead>
                <TableHead className="text-right">{td.transactionsColumn}</TableHead>
                <TableHead>{td.percentColumn}</TableHead>
                <TableHead>{td.exceededColumn}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.periods.map((period) => (
                <TableRow key={`${period.role}|${period.from}|${period.to}`} data-testid="nexus-period">
                  <TableCell>
                    {fill(t.weldbooksUs.salesTax.center.overview.periodRange, {
                      start: formatDate(period.from),
                      end: formatDate(period.to),
                    })}
                  </TableCell>
                  <TableCell>{(td.roles as Record<string, string>)[period.role] ?? period.role}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(period.salesTotal)}</TableCell>
                  <TableCell className="text-right tabular-nums">{period.transactionCount}</TableCell>
                  <TableCell>
                    <NexusProgressBar row={{ percentOfThreshold: period.percentOfThreshold, registered: detail.registered }} />
                  </TableCell>
                  <TableCell>{period.exceeded ? (period.exceededOn ? formatDate(period.exceededOn) : tn.registeredYes) : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{td.ruleTitle}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label={td.salesThreshold}>{rule.salesThreshold === null ? '—' : formatMoney(rule.salesThreshold)}</Field>
            <Field label={td.transactionThreshold}>{rule.transactionThreshold === null ? '—' : rule.transactionThreshold}</Field>
            <Field label={td.test}>{(td.tests as Record<string, string>)[rule.test] ?? rule.test}</Field>
            <Field label={td.comparison}>{(td.comparisons as Record<string, string>)[rule.comparison] ?? rule.comparison}</Field>
            <Field label={td.base}>{(td.bases as Record<string, string>)[rule.base] ?? rule.base}</Field>
            <Field label={td.window}>{(td.windowTypes as Record<string, string>)[rule.window] ?? rule.window}</Field>
            <Field label={td.marketplace}>
              {rule.marketplaceSalesCount ? t.weldbooksUs.salesTax.center.common.yes : t.weldbooksUs.salesTax.center.common.no}
            </Field>
            <Field label={td.effectiveFrom}>{formatDate(rule.effectiveFrom)}</Field>
          </dl>
          {detail.sourceUrl ? (
            <p className="text-sm">
              <a
                href={detail.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                {td.openSource}
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            </p>
          ) : null}
          {detail.unverified.length > 0 ? (
            <Notice tone="warning" title={td.unverifiedTitle} data-testid="nexus-unverified">
              <p>{td.unverifiedDescription}</p>
              <ul className="list-disc pl-5">
                {detail.unverified.map((flag) => (
                  <li key={flag}>{(td.unverifiedFlags as Record<string, string>)[flag] ?? flag}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
          {detail.ruleNotes ? (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">{td.notes}</p>
              <p className="text-sm">{detail.ruleNotes}</p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{td.monthlyTitle}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <MonthlyChart months={detail.monthly} />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{td.month}</TableHead>
                <TableHead className="text-right">{td.monthSales}</TableHead>
                <TableHead className="text-right">{td.monthTransactions}</TableHead>
                <TableHead className="text-right">{td.monthGross}</TableHead>
                <TableHead className="text-right">{td.monthTaxable}</TableHead>
                <TableHead className="text-right">{td.monthMarketplace}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.monthly.map((month) => (
                <TableRow key={month.month} data-testid="nexus-month">
                  <TableCell>{formatMonth(`${month.month}-01`)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(month.sales)}</TableCell>
                  <TableCell className="text-right tabular-nums">{month.transactions}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(month.gross)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(month.taxable)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(month.marketplaceSales)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function NexusDetailContent({ state }: Readonly<{ state: string }>) {
  const { t } = useI18n();
  const td = t.weldbooksUs.salesTax.center.nexus.detail;
  const query = useNexusDetail(state.toUpperCase());

  if (query.isLoading) return <DetailSkeleton />;
  if (query.isError || !query.data) {
    const notFound = isSalesTaxRequestError(query.error) && query.error.status === 404;
    return notFound ? (
      <EmptyState
        icon={MapPin}
        title={td.notFoundTitle}
        description={td.notFoundDescription}
        action={
          <Button asChild variant="outline">
            <Link to="/weldbooks/sales-tax/nexus">{td.back}</Link>
          </Button>
        }
      />
    ) : (
      <ErrorState error={query.error} onRetry={() => void query.refetch()} />
    );
  }
  return <NexusDetailView detail={query.data} />;
}

/** One state of the nexus monitor: the measurement, the state's rule and the months of sales behind it. */
export default function NexusStatePage() {
  const { t } = useI18n();
  const { state } = useParams({ strict: false }) as { state: string };
  return (
    <SalesTaxGate>
      <div className="space-y-4 p-4 sm:p-6">
        <Link
          to="/weldbooks/sales-tax/nexus"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          {t.weldbooksUs.salesTax.center.nexus.detail.back}
        </Link>
        <NexusDetailContent state={state} />
      </div>
    </SalesTaxGate>
  );
}
