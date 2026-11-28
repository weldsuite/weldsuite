/**
 * The Bank lines tab of the contact page (edition feature `books-contact-page`): the bank lines
 * linked to the contact (`/bank-transactions?contactId=`), newest first, a page at a time. A line
 * opens as a stacked panel. It is a real table, so a screen reader reads each amount with its header.
 */

import { Button } from '@weldsuite/ui/components/button';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { RecordLink } from '@/components/object-panel/record-link';
import { useContactBankLines } from '@/hooks/queries/use-weldbooks-contact-page-queries';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

export function ContactBankLinesTab({ contactId }: Readonly<{ contactId: string }>) {
  const { t } = useI18n();
  const copy = t.weldbooksContactPage.bankLines;
  const { formatDate, formatMoney } = useWeldbooksFormat();
  const query = useContactBankLines(contactId);
  const rows = query.data?.rows ?? [];

  if (query.isLoading) return <InlineSpinner />;
  if (query.isError && rows.length === 0) {
    return (
      <div className="p-4">
        <ErrorState message={copy.loadFailed} onRetry={() => void query.refetch()} />
      </div>
    );
  }
  if (rows.length === 0) return <p className="p-6 text-center text-sm text-muted-foreground">{copy.empty}</p>;

  return (
    <div className="px-4 pb-4">
      <div
        role="region"
        aria-label={copy.caption}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        className="overflow-x-auto"
      >
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{copy.caption}</caption>
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th scope="col" className="py-2 pr-3 font-medium">
                {copy.date}
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                {copy.description}
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                {copy.amount}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((line) => {
              const incoming = Number(line.amount) >= 0;
              const label = line.counterpartyName || line.description || copy.noDescription;
              return (
                <tr key={line.id} className="border-b border-border last:border-b-0">
                  <td className="whitespace-nowrap py-2 pr-3 tabular-nums text-muted-foreground">
                    {formatDate(line.date)}
                  </td>
                  <td className="max-w-0 py-2 pr-3">
                    <div className="flex min-w-0 items-center">
                      <RecordLink type="bank_transaction" id={line.id} label={label} />
                    </div>
                  </td>
                  <td
                    className={cn(
                      'whitespace-nowrap py-2 text-right font-medium tabular-nums',
                      incoming ? 'text-emerald-700 dark:text-emerald-400' : 'text-foreground',
                    )}
                  >
                    <span className="sr-only">{incoming ? copy.moneyIn : copy.moneyOut}: </span>
                    {formatMoney(line.amount)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {query.hasNextPage ? (
        <div className="flex justify-center pt-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {t.accounting.contacts.connected.loadMore}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
