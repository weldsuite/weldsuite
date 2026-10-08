import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ShieldCheck } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import {
  useExpiringCertificatesReport,
  useMissingCertificatesReport,
} from '@/hooks/queries/use-weldbooks-sales-tax-center-queries';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { DateRangeFilter } from '../shared/date-range';
import { DocumentLink } from '../shared/document-link';
import { CardsSkeleton, EmptyState, ErrorState, RowsSkeleton } from '../shared/query-states';
import { SalesTaxFrame } from '../shared/sales-tax-frame';
import { fill } from '../shared/text';
import { EXPIRING_WINDOWS, cureText, expiryText, expiryUrgency } from './certificate-model';

type CertificateTab = 'expiring' | 'missing';

function CustomerLink({ id, name }: Readonly<{ id: string | null; name: string | null }>) {
  if (!id) return <span>{name ?? '—'}</span>;
  return (
    <Link to="/weldbooks/customers/$id" params={{ id }} className="text-primary hover:underline">
      {name ?? id}
    </Link>
  );
}

/** Certificates that stop covering a state soon, and the ones that lapsed in the last year. */
function ExpiringCertificates() {
  const { t } = useI18n();
  const te = t.weldbooksUs.salesTax.center.certificates.expiring;
  const reasons = t.weldbooksUs.salesTax.center.exemptReasons as Record<string, string>;
  const { formatDate } = useWeldbooksFormat();
  const [days, setDays] = useState<number>(60);
  const query = useExpiringCertificatesReport(days);
  const report = query.data;
  const forms = te.forms as Record<string, string>;
  const statuses = te.statuses as Record<string, string>;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{te.description}</p>
      <div className="space-y-1.5">
        <Label htmlFor="certificates-days">{te.within}</Label>
        <Select value={String(days)} onValueChange={(value) => setDays(Number(value))}>
          <SelectTrigger id="certificates-days" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EXPIRING_WINDOWS.map((option) => (
              <SelectItem key={option} value={String(option)}>
                {fill(te.daysOption, { count: option })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {query.isLoading ? (
        <RowsSkeleton rows={5} />
      ) : query.isError && !report ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : report && report.certificates.length === 0 ? (
        <EmptyState icon={ShieldCheck} title={te.empty} description={te.emptyDescription} />
      ) : report ? (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{te.customer}</TableHead>
                  <TableHead>{te.certificate}</TableHead>
                  <TableHead>{te.reason}</TableHead>
                  <TableHead>{te.form}</TableHead>
                  <TableHead>{te.states}</TableHead>
                  <TableHead>{te.expires}</TableHead>
                  <TableHead>{te.lastUsed}</TableHead>
                  <TableHead>{te.status}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.certificates.map((certificate) => {
                  const urgency = expiryUrgency(certificate.daysLeft);
                  return (
                    <TableRow key={certificate.certificateId} data-testid="expiring-certificate" data-urgency={urgency}>
                      <TableCell>
                        <CustomerLink id={certificate.partyId} name={certificate.customerName} />
                      </TableCell>
                      <TableCell>
                        {certificate.certificateNumber ?? '—'}
                        {certificate.blanket ? (
                          <Badge variant="outline" className="ml-2">
                            {te.blanket}
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell>{reasons[certificate.reason] ?? certificate.reason}</TableCell>
                      <TableCell>{forms[certificate.form] ?? certificate.form}</TableCell>
                      <TableCell className="max-w-[12rem] whitespace-normal">{certificate.states.join(', ') || '—'}</TableCell>
                      <TableCell>
                        <div>{formatDate(certificate.expiresOn)}</div>
                        <div
                          className={cn(
                            'text-xs',
                            urgency === 'expired' && 'font-medium text-destructive',
                            urgency === 'soon' && 'text-amber-600 dark:text-amber-400',
                            urgency === 'later' && 'text-muted-foreground',
                          )}
                        >
                          {expiryText(te, certificate.daysLeft)}
                        </div>
                      </TableCell>
                      <TableCell>{certificate.lastUsedOn ? formatDate(certificate.lastUsedOn) : te.never}</TableCell>
                      <TableCell>
                        <Badge variant={certificate.expired ? 'destructive' : 'success'}>
                          {statuses[certificate.expired ? 'expired' : certificate.status] ?? certificate.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

/** Exempt sales with no certificate on file, with the date by which one has to arrive. */
function MissingCertificates() {
  const { t } = useI18n();
  const tm = t.weldbooksUs.salesTax.center.certificates.missing;
  const reasons = t.weldbooksUs.salesTax.center.exemptReasons as Record<string, string>;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const [range, setRange] = useState({ from: '', to: '' });
  const query = useMissingCertificatesReport({ from: range.from || undefined, to: range.to || undefined });
  const report = query.data;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{tm.description}</p>
      <div className="flex flex-wrap items-end gap-3">
        <DateRangeFilter idPrefix="missing-certificates" from={range.from} to={range.to} onChange={setRange} />
      </div>

      {query.isLoading ? (
        <CardsSkeleton count={3} />
      ) : query.isError && !report ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : report && report.certificates.length === 0 ? (
        <EmptyState icon={ShieldCheck} title={tm.empty} description={tm.emptyDescription} />
      ) : report ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Card>
              <CardContent className="space-y-1 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{tm.totalsDocuments}</p>
                <p className="text-xl font-semibold tabular-nums">{report.totals.documents}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="space-y-1 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{tm.totalsExempt}</p>
                <p className="text-xl font-semibold tabular-nums">{formatMoney(report.totals.exemptSales)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="space-y-1 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{tm.totalsPast}</p>
                <p
                  className={cn('text-xl font-semibold tabular-nums', report.totals.pastDeadline > 0 && 'text-destructive')}
                  data-testid="missing-past-deadline"
                >
                  {report.totals.pastDeadline}
                </p>
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{tm.document}</TableHead>
                    <TableHead>{tm.customer}</TableHead>
                    <TableHead>{tm.state}</TableHead>
                    <TableHead>{tm.saleDate}</TableHead>
                    <TableHead className="text-right">{tm.exemptSales}</TableHead>
                    <TableHead>{tm.reason}</TableHead>
                    <TableHead>{tm.cureDeadline}</TableHead>
                    <TableHead>{tm.timeLeft}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.certificates.map((missing) => (
                    <TableRow
                      key={`${missing.documentType}|${missing.documentId ?? ''}|${missing.saleDate}`}
                      data-testid="missing-certificate"
                      data-past-deadline={missing.pastDeadline}
                      className={cn(missing.pastDeadline && 'bg-destructive/5')}
                    >
                      <TableCell>
                        <DocumentLink type={missing.documentType} id={missing.documentId} number={missing.documentNumber} />
                      </TableCell>
                      <TableCell>
                        <CustomerLink id={missing.customerId} name={missing.customerName} />
                      </TableCell>
                      <TableCell>{missing.stateCode ?? '—'}</TableCell>
                      <TableCell>{formatDate(missing.saleDate)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(missing.exemptSales)}</TableCell>
                      <TableCell>{missing.exemptReason ? (reasons[missing.exemptReason] ?? missing.exemptReason) : '—'}</TableCell>
                      <TableCell>{formatDate(missing.cureDeadline)}</TableCell>
                      <TableCell>
                        {missing.pastDeadline ? (
                          <div className="space-y-0.5">
                            <Badge variant="destructive">{tm.pastDeadline}</Badge>
                            <div className="text-xs text-destructive">{cureText(tm, missing.daysLeft)}</div>
                          </div>
                        ) : (
                          <span className={cn(missing.daysLeft <= 14 && 'font-medium text-amber-600 dark:text-amber-400')}>
                            {cureText(tm, missing.daysLeft)}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}

/** The exemption certificate reports: certificates about to expire and exempt sales that still have none. */
export default function CertificateReportsPage() {
  const { t } = useI18n();
  const tc = t.weldbooksUs.salesTax.center.certificates;
  const [tab, setTab] = useState<CertificateTab>('expiring');

  return (
    <SalesTaxFrame title={tc.title} subtitle={tc.subtitle}>
      <Tabs value={tab} onValueChange={(value) => setTab(value as CertificateTab)}>
        <TabsList>
          <TabsTrigger value="expiring">{tc.tabs.expiring}</TabsTrigger>
          <TabsTrigger value="missing">{tc.tabs.missing}</TabsTrigger>
        </TabsList>
        <TabsContent value="expiring">
          <ExpiringCertificates />
        </TabsContent>
        <TabsContent value="missing">
          <MissingCertificates />
        </TabsContent>
      </Tabs>
    </SalesTaxFrame>
  );
}
