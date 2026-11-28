/**
 * The four tiles at the top of the contact page (edition feature `books-contact-page`): what the
 * contact still has to pay us and what of it is overdue, what we still have to pay them, and the
 * hours not invoiced yet. A contact in several currencies shows the first in full and the others
 * under it, never a made-up total. Each tile opens what it counts: the Invoices tab filtered to
 * open or overdue invoices, the Bills tab, or the Unbilled time page for this customer.
 */

import type { ReactNode } from 'react';
import { Clock, Hourglass, ReceiptText, TriangleAlert, Wallet } from 'lucide-react';
import { KpiCard, KpiGrid, type KpiTone } from '@weldsuite/ui/components/kpi-card';
import { KpiCardLink } from '@/components/kpi-card-link';
import { useI18n } from '@/lib/i18n/provider';
import { plural } from '@/lib/i18n/plural';
import type { ContactSummary } from '@/lib/api/domains/weldbooks-contact-page';
import { countOf, describeSums, nonZero } from '@/lib/weldbooks/contact-page';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { cn } from '@/lib/utils';
import type { ContactDocumentView } from './weldbooks-contact-documents-tab';

/** Where a tile leads inside the panel. */
export type ContactTileTarget = { tab: 'invoices'; view: ContactDocumentView } | { tab: 'bills'; view: ContactDocumentView };

interface TileProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: KpiTone;
  loading?: boolean;
  icon: Parameters<typeof KpiCard>[0]['icon'];
  onOpen: () => void;
}

/** A tile that opens a tab of the panel: a real button, so the keyboard reaches it. */
function TileButton({ label, value, hint, tone, loading, icon, onOpen }: Readonly<TileProps>) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'block w-full rounded-xl text-left',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      <KpiCard label={label} value={value} hint={hint} tone={tone} loading={loading} icon={icon} interactive />
    </button>
  );
}

export function ContactTiles({
  contactId,
  summary,
  showReceivable,
  showPayable,
  canSeeTime,
  onOpen,
  failed,
}: Readonly<{
  contactId: string;
  summary: ContactSummary | undefined;
  showReceivable: boolean;
  showPayable: boolean;
  /** The member may read time: the Unbilled time tile is for them. */
  canSeeTime: boolean;
  onOpen: (target: ContactTileTarget) => void;
  failed?: boolean;
}>) {
  const { t, language } = useI18n();
  const copy = t.weldbooksContactPage.tiles;
  const { formatMoney, formatNumber } = useWeldbooksFormat();
  const loading = summary === undefined && !failed;

  const toReceive = describeSums(summary?.toReceive, formatMoney);
  const overdue = describeSums(summary?.overdue, formatMoney);
  const toPay = describeSums(summary?.toPay, formatMoney);
  const others = (sums: string[]) => (sums.length > 0 ? copy.moreCurrencies.replace('{amounts}', sums.join(', ')) : null);
  const unbilled = summary?.unbilledHours;
  const hasUnbilled = Boolean(unbilled) && Number(unbilled?.hours) > 0;

  const receiveCount = countOf(summary?.toReceive);
  const payCount = countOf(summary?.toPay);
  const toReceiveHint =
    others(toReceive.others) ??
    (receiveCount > 0 ? plural(receiveCount, copy.invoices, language) : copy.nothingOpen);
  const toPayHint =
    others(toPay.others) ?? (payCount > 0 ? plural(payCount, copy.bills, language) : copy.nothingOpen);
  const overdueHint = others(overdue.others) ?? (overdue.isEmpty ? copy.nothingOverdue : null);

  if (failed) return <p className="px-4 pb-3 text-sm text-destructive">{copy.summaryFailed}</p>;

  return (
    <section aria-label={copy.label} className="px-4 pb-3 pt-1">
      <KpiGrid fit="container">
        {showReceivable ? (
          <TileButton
            label={copy.toReceive}
            value={toReceive.primary}
            loading={loading}
            hint={toReceiveHint}
            icon={ReceiptText}
            onOpen={() => onOpen({ tab: 'invoices', view: 'open' })}
          />
        ) : null}
        {showReceivable ? (
          <TileButton
            label={copy.overdue}
            value={overdue.primary}
            loading={loading}
            hint={overdueHint}
            tone={overdue.isEmpty ? 'default' : 'danger'}
            icon={TriangleAlert}
            onOpen={() => onOpen({ tab: 'invoices', view: 'overdue' })}
          />
        ) : null}
        {showPayable ? (
          <TileButton
            label={copy.toPay}
            value={toPay.primary}
            loading={loading}
            hint={toPayHint}
            icon={Wallet}
            onOpen={() => onOpen({ tab: 'bills', view: 'open' })}
          />
        ) : null}
        {showReceivable && canSeeTime ? (
          <KpiCardLink
            label={copy.unbilled}
            value={hasUnbilled ? copy.hours.replace('{hours}', formatNumber(unbilled?.hours)) : copy.noUnbilled}
            loading={loading}
            hint={
              hasUnbilled && unbilled
                ? `${formatMoney(unbilled.amount, unbilled.currency)} · ${copy.invoiceIt}`
                : undefined
            }
            icon={hasUnbilled ? Hourglass : Clock}
            href={hasUnbilled ? `/weldbooks/time/unbilled?customerId=${encodeURIComponent(contactId)}` : undefined}
          />
        ) : null}
      </KpiGrid>
      {nonZero(summary?.unappliedCredit).length > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {copy.credit.replace(
            '{amount}',
            nonZero(summary?.unappliedCredit)
              .map((sum) => formatMoney(sum.amount, sum.currency))
              .join(', '),
          )}
        </p>
      ) : null}
    </section>
  );
}
