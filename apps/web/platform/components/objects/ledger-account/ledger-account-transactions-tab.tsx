/**
 * Transactions tab of the ledger account panel: the posted journal lines of the account, newest
 * entry first, a page at a time. A row opens its journal entry as a stacked object panel (the back
 * arrow returns here); the toolbar links to the General ledger report for the account.
 *
 * The endpoint gives no running balance, so none is shown; the General ledger has one.
 */

import { Link } from '@tanstack/react-router';
import { BookOpen } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { useObjectPanel } from '@/components/object-panel';
import { useInfiniteAccountingAccountTransactions } from '@/hooks/queries/use-accounting-queries';
import { useI18n } from '@/lib/i18n/provider';
import { journalSourceLabel } from '@/lib/weldbooks/journal-source';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

/** The General ledger report for the account. */
export function LedgerReportLink({ accountId }: Readonly<{ accountId: string }>) {
  const { t } = useI18n();
  return (
    <Button variant="outline" size="sm" asChild>
      <Link to="/weldbooks/reports/general-ledger" search={{ accountId }}>
        <BookOpen className="mr-1 h-4 w-4" aria-hidden />
        {t.accounting.accounts.transactionList.openLedger}
      </Link>
    </Button>
  );
}

/** A debit or credit cell: blank when the line has nothing on that side. */
function amountOrBlank(value: string | null, format: (amount: string) => string): string {
  return value && Number(value) !== 0 ? format(value) : '';
}

export function LedgerAccountTransactionsTab({ accountId }: Readonly<{ accountId: string }>) {
  const { t } = useI18n();
  const tl = t.accounting.accounts.transactionList;
  const sources = t.accounting.statusLabels.journalEntrySource as Record<string, string>;
  const { formatDate, formatMoney } = useWeldbooksFormat();
  const { open: openPanel } = useObjectPanel();
  const query = useInfiniteAccountingAccountTransactions(accountId);
  const rows = query.data?.rows ?? [];

  const toolbar = (
    <div className="flex items-center justify-between gap-3 px-4 pb-3 pt-3">
      <p className="min-w-0 text-xs text-muted-foreground">{tl.noRunningBalance}</p>
      <div className="flex-shrink-0">
        <LedgerReportLink accountId={accountId} />
      </div>
    </div>
  );

  if (query.isError && rows.length === 0) {
    return (
      <>
        {toolbar}
        <div className="p-4 text-sm text-destructive">{tl.failed}</div>
      </>
    );
  }
  if (query.isLoading) {
    return (
      <div className="space-y-2 p-4" aria-busy="true">
        {[0, 1, 2, 3].map((key) => (
          <div key={key} className="h-9 animate-pulse rounded bg-muted" />
        ))}
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <>
        {toolbar}
        <p className="p-6 text-center text-sm text-muted-foreground">{tl.empty}</p>
      </>
    );
  }

  return (
    <TabListScope>
      {toolbar}
      <div className="border-t border-gray-200/70 dark:border-border">
        <div className="flex items-center gap-4 border-b border-gray-200/70 px-4 py-2 text-xs font-medium text-muted-foreground dark:border-border">
          <span className="w-[92px] flex-shrink-0 @max-[440px]:w-[72px]">{tl.colDate}</span>
          <span className="min-w-0 flex-1">{tl.colDescription}</span>
          <span className="w-[88px] flex-shrink-0 text-right">{tl.colDebit}</span>
          <span className="w-[88px] flex-shrink-0 text-right">{tl.colCredit}</span>
          <span className="w-[40px] flex-shrink-0" aria-hidden />
        </div>
        {rows.map((line) => {
          const entry = line.entryNumber ?? '—';
          const description = line.description || line.entryDescription;
          return (
            <TabListRow
              key={line.id}
              label={tl.openEntry.replace('{entry}', entry)}
              onOpen={() => openPanel({ type: 'journal_entry', id: line.journalEntryId, stack: true })}
            >
              <span className="w-[92px] flex-shrink-0 whitespace-nowrap text-sm tabular-nums @max-[440px]:w-[72px]">
                {formatDate(line.entryDate)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{entry}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {[journalSourceLabel(line.sourceType, sources), description].filter(Boolean).join(' · ')}
                </div>
              </div>
              <span className="w-[88px] flex-shrink-0 text-right text-sm tabular-nums">
                {amountOrBlank(line.debit, (amount) => formatMoney(amount))}
              </span>
              <span className="w-[88px] flex-shrink-0 text-right text-sm tabular-nums">
                {amountOrBlank(line.credit, (amount) => formatMoney(amount))}
              </span>
            </TabListRow>
          );
        })}
      </div>
      {query.hasNextPage ? (
        <div className="flex justify-center p-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage ? t.accounting.contacts.pickerSearching : tl.loadMore}
          </Button>
        </div>
      ) : null}
    </TabListScope>
  );
}
