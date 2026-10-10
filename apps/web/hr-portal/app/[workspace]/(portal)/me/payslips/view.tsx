'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Download } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { usePortalQuery } from '@/lib/hooks/use-portal-query';
import { portalDownload } from '@/lib/client';
import { formatDate } from '@/lib/date';
import { invalidatePortal } from '@/lib/query-client';
import { formatMoney } from '@/lib/payroll/format';
import type { HrAnnualStatement, HrMyPayslip } from '@/lib/payroll/types';
import { Button, Card, PageHeader } from '@/components/ui/primitives';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';

/** Payslips newest first, grouped by the year they were paid in. */
function groupByYear(payslips: HrMyPayslip[]): Array<{ year: string; payslips: HrMyPayslip[] }> {
  const sorted = [...payslips].sort((a, b) => b.payDate.localeCompare(a.payDate));
  const groups: Array<{ year: string; payslips: HrMyPayslip[] }> = [];
  for (const payslip of sorted) {
    const year = payslip.payDate.slice(0, 4);
    const last = groups[groups.length - 1];
    if (last?.year === year) last.payslips.push(payslip);
    else groups.push({ year, payslips: [payslip] });
  }
  return groups;
}

function statementKey(statement: HrAnnualStatement): string {
  return `${statement.year}:${statement.employerId}`;
}

export default function PayslipsView() {
  const slug = String(useParams().workspace ?? '');
  const { dict, locale, timeZone, format } = useI18n();
  const t = dict.payroll.payslips;
  const payslips = usePortalQuery<HrMyPayslip[]>(slug, '/employee/payslips');
  const statements = usePortalQuery<HrAnnualStatement[]>(slug, '/employee/annual-statements');

  // The id of whatever is downloading, and the one row that failed.
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);

  async function download(id: string, path: string, options: { query?: Record<string, string>; fallbackName: string }, markRead: boolean) {
    setBusyId(id);
    setFailedId(null);
    try {
      await portalDownload(slug, path, options);
      // The API marks a payslip as read when its PDF is fetched.
      if (markRead) void invalidatePortal(slug, ['/employee/payslips']);
    } catch {
      setFailedId(id);
    } finally {
      setBusyId(null);
    }
  }

  if (payslips.loading || statements.loading) return <LoadingState />;
  if (payslips.error || statements.error) {
    return (
      <ErrorState
        onRetry={() => {
          payslips.refetch();
          statements.refetch();
        }}
      />
    );
  }

  const groups = groupByYear(payslips.data);
  const sortedStatements = [...statements.data].sort(
    (a, b) => b.year - a.year || a.employerName.localeCompare(b.employerName),
  );

  return (
    <div className="space-y-6">
      <PageHeader title={t.title} />

      <Card>
        <h2 className="font-medium text-gray-900 mb-3">{t.listTitle}</h2>
        {groups.length === 0 ? (
          <EmptyState message={t.empty} />
        ) : (
          <div className="space-y-5">
            {groups.map((group) => (
              <section key={group.year} aria-label={group.year}>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">{group.year}</h3>
                <ul className="divide-y divide-gray-100">
                  {group.payslips.map((payslip) => (
                    <li key={payslip.id} className="py-3 flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 flex flex-wrap items-center gap-2">
                          {format(t.period, {
                            start: formatDate(payslip.periodStart, locale, timeZone),
                            end: formatDate(payslip.periodEnd, locale, timeZone),
                          })}
                          {payslip.viewedAt === null && <Badge tone="info">{t.new}</Badge>}
                        </p>
                        <p className="text-xs text-gray-500">
                          {format(t.paidOn, { date: formatDate(payslip.payDate, locale, timeZone) })} · {payslip.employerName}
                          {payslip.number && ` · ${format(t.number, { number: payslip.number })}`}
                        </p>
                        {failedId === payslip.id && (
                          <p role="alert" className="text-xs text-red-600 mt-0.5">
                            {t.downloadFailed}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-4">
                        <dl className="text-right text-sm">
                          <div className="flex justify-end gap-2">
                            <dt className="text-gray-500">{t.net}</dt>
                            <dd className="font-medium text-gray-900">{formatMoney(payslip.netPay, payslip.currency, locale)}</dd>
                          </div>
                          <div className="flex justify-end gap-2 text-xs">
                            <dt className="text-gray-500">{t.gross}</dt>
                            <dd className="text-gray-600">{formatMoney(payslip.grossPay, payslip.currency, locale)}</dd>
                          </div>
                        </dl>
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={busyId !== null}
                          onClick={() =>
                            void download(
                              payslip.id,
                              `/employee/payslips/${payslip.id}/pdf`,
                              { fallbackName: `payslip-${payslip.payDate}.pdf` },
                              true,
                            )
                          }
                        >
                          <Download size={16} aria-hidden="true" />
                          {busyId === payslip.id ? t.downloading : t.download}
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <h2 className="font-medium text-gray-900 mb-3">{t.statementsTitle}</h2>
        {sortedStatements.length === 0 ? (
          <EmptyState message={t.statementsEmpty} />
        ) : (
          <ul className="divide-y divide-gray-100">
            {sortedStatements.map((statement) => {
              const key = statementKey(statement);
              return (
                <li key={key} className="py-3 flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900">{format(t.statement[statement.kind], { year: statement.year })}</p>
                    <p className="text-xs text-gray-500">
                      {t.statementHint[statement.kind]} · {statement.employerName}
                    </p>
                    {failedId === key && (
                      <p role="alert" className="text-xs text-red-600 mt-0.5">
                        {t.downloadFailed}
                      </p>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busyId !== null}
                    onClick={() =>
                      void download(
                        key,
                        `/employee/annual-statements/${statement.year}`,
                        { query: { employerId: statement.employerId }, fallbackName: `${statement.kind}-${statement.year}.pdf` },
                        false,
                      )
                    }
                  >
                    <Download size={16} aria-hidden="true" />
                    {busyId === key ? t.downloading : t.download}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
