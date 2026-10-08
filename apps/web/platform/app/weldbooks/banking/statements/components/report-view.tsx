import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import type { ReconciliationReport, ReportGroup } from '@/lib/api/domains/weldbooks-banking';

interface ReportViewProps {
  report: ReconciliationReport;
  formatAmount: (amount: number) => string;
  formatDate: (date: string) => string;
  /** Plain black-on-white styling for the printed copy. */
  print?: boolean;
}

function SummaryRow({
  label,
  value,
  strong,
  testId,
}: Readonly<{ label: string; value: string; strong?: boolean; testId?: string }>) {
  return (
    <tr className={cn(strong && 'font-semibold')}>
      <td className="py-1 pr-6">{label}</td>
      <td className="py-1 text-right tabular-nums" data-testid={testId}>{value}</td>
    </tr>
  );
}

function GroupTable({
  title,
  group,
  formatAmount,
  formatDate,
}: Readonly<{ title: string; group: ReportGroup; formatAmount: (n: number) => string; formatDate: (d: string) => string }>) {
  const { t } = useI18n();
  const tr = t.weldbooksUs.banking.report;
  if (group.count === 0) return null;
  return (
    <section className="break-inside-avoid space-y-1">
      <h3 className="text-sm font-semibold">
        {title} <span className="font-normal text-muted-foreground">({group.count})</span>
      </h3>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="py-1 pr-3 font-medium">{tr.columns.date}</th>
            <th className="py-1 pr-3 font-medium">{tr.columns.reference}</th>
            <th className="py-1 pr-3 font-medium">{tr.columns.name}</th>
            <th className="py-1 pr-3 font-medium">{tr.columns.description}</th>
            <th className="py-1 text-right font-medium">{tr.columns.amount}</th>
          </tr>
        </thead>
        <tbody>
          {group.items.map((item) => (
            <tr key={item.id} className="border-b border-border/50 align-top">
              <td className="whitespace-nowrap py-1 pr-3">{formatDate(item.date)}</td>
              <td className="py-1 pr-3">
                {[item.checkNumber ? tr.checkNumber.replace('{number}', item.checkNumber) : null, item.documentNumber ?? item.entryNumber]
                  .filter(Boolean)
                  .join(' · ')}
              </td>
              <td className="py-1 pr-3">{item.contactName ?? ''}</td>
              <td className="py-1 pr-3">{item.description ?? ''}</td>
              <td className="py-1 text-right tabular-nums">{formatAmount(item.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-semibold">
            <td colSpan={4} className="py-1 pr-3">{tr.total}</td>
            <td className="py-1 text-right tabular-nums">{formatAmount(group.total)}</td>
          </tr>
        </tfoot>
      </table>
    </section>
  );
}

/**
 * The reconciliation report: how the books and the statement agree (cleared
 * balance, difference), the register as of the statement date and today, and
 * every cleared and uncleared line. Shown on screen and, through the print
 * button, as the PDF the browser prints.
 */
export function ReconciliationReportView({ report, formatAmount, formatDate, print }: Readonly<ReportViewProps>) {
  const { t } = useI18n();
  const tr = t.weldbooksUs.banking.report;
  const card = report.accountKind === 'credit_card';
  const s = report.summary;

  return (
    <div className={cn('space-y-6', print && 'bg-white p-8 text-black')} data-testid="reconciliation-report">
      <header className="space-y-0.5">
        <h2 className="text-xl font-semibold">{card ? tr.titleCard : tr.title}</h2>
        <p className="text-sm text-muted-foreground">
          {report.bankAccountName ?? ''} · {report.ledgerAccount.code} {report.ledgerAccount.name}
        </p>
        <p className="text-sm text-muted-foreground">{tr.statementDate.replace('{date}', formatDate(report.statementDate))}</p>
        {report.preview ? <p className="text-sm font-medium text-amber-700">{tr.preview}</p> : null}
      </header>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <section>
          <h3 className="mb-1 text-sm font-semibold">{tr.statementSummary}</h3>
          <table className="text-sm">
            <tbody>
              <SummaryRow label={card ? tr.beginningBalanceOwed : tr.beginningBalance} value={formatAmount(s.beginningBalance)} />
              <SummaryRow
                label={(card ? tr.clearedInflowsCard : tr.clearedInflows).replace('{count}', String(s.clearedInflows.count))}
                value={formatAmount(s.clearedInflows.total)}
              />
              <SummaryRow
                label={(card ? tr.clearedOutflowsCard : tr.clearedOutflows).replace('{count}', String(s.clearedOutflows.count))}
                value={formatAmount(s.clearedOutflows.total)}
              />
              <SummaryRow strong label={card ? tr.clearedBalanceOwed : tr.clearedBalance} value={formatAmount(s.clearedBalance)} />
              <SummaryRow label={card ? tr.statementBalanceOwed : tr.statementBalance} value={formatAmount(s.statementEndingBalance)} />
              <SummaryRow strong label={tr.difference} value={formatAmount(s.difference)} testId="report-difference" />
            </tbody>
          </table>
        </section>

        <section>
          <h3 className="mb-1 text-sm font-semibold">{tr.register}</h3>
          <table className="text-sm">
            <tbody>
              <SummaryRow strong label={tr.registerAtStatement} value={formatAmount(s.registerBalanceAtStatementDate)} />
              <SummaryRow
                label={(card ? tr.unclearedInflowsCard : tr.unclearedInflows).replace('{count}', String(s.unclearedInflows.count))}
                value={formatAmount(s.unclearedInflows.total)}
              />
              <SummaryRow
                label={(card ? tr.unclearedOutflowsCard : tr.unclearedOutflows).replace('{count}', String(s.unclearedOutflows.count))}
                value={formatAmount(s.unclearedOutflows.total)}
              />
              <SummaryRow
                label={tr.afterInflows.replace('{count}', String(s.unclearedAfterStatementInflows.count))}
                value={formatAmount(s.unclearedAfterStatementInflows.total)}
              />
              <SummaryRow
                label={tr.afterOutflows.replace('{count}', String(s.unclearedAfterStatementOutflows.count))}
                value={formatAmount(s.unclearedAfterStatementOutflows.total)}
              />
              <SummaryRow strong label={tr.registerToday} value={formatAmount(s.registerBalanceToday)} />
            </tbody>
          </table>
        </section>
      </div>

      {report.adjustment ? (
        <p className="rounded-md border p-3 text-sm" data-testid="report-adjustment">
          {tr.adjustment
            .replace('{amount}', formatAmount(report.adjustment.amount))
            .replace('{account}', report.adjustment.accountName ?? report.adjustment.accountId)}
          {report.adjustment.memo ? ` (${report.adjustment.memo})` : ''}
        </p>
      ) : null}

      <div className="space-y-5">
        <GroupTable title={card ? tr.groups.clearedInflowsCard : tr.groups.clearedInflows} group={report.clearedInflows} formatAmount={formatAmount} formatDate={formatDate} />
        <GroupTable title={card ? tr.groups.clearedOutflowsCard : tr.groups.clearedOutflows} group={report.clearedOutflows} formatAmount={formatAmount} formatDate={formatDate} />
        <GroupTable title={card ? tr.groups.unclearedInflowsCard : tr.groups.unclearedInflows} group={report.unclearedInflows} formatAmount={formatAmount} formatDate={formatDate} />
        <GroupTable title={card ? tr.groups.unclearedOutflowsCard : tr.groups.unclearedOutflows} group={report.unclearedOutflows} formatAmount={formatAmount} formatDate={formatDate} />
        <GroupTable title={tr.groups.afterInflows} group={report.unclearedAfterStatementInflows} formatAmount={formatAmount} formatDate={formatDate} />
        <GroupTable title={tr.groups.afterOutflows} group={report.unclearedAfterStatementOutflows} formatAmount={formatAmount} formatDate={formatDate} />
      </div>
    </div>
  );
}
