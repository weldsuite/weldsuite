/**
 * Sending payment reminders for several invoices at once (edition feature
 * `books-reminders`): a confirmation, the call (`POST /invoices/remind-bulk`:
 * one e-mail per contact and level) and a summary of who got what and which
 * invoices were skipped, and why, in plain words. The Invoices list and the To
 * process card share it.
 */

import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { useRemindBulk } from '@/hooks/queries/use-weldbooks-sales-queries';
import type { BulkRemindResult } from '@/lib/api/domains/weldbooks-sales';
import { useI18n } from '@/lib/i18n/provider';
import { plural } from '@/lib/i18n/plural';
import { getLocale } from '@/lib/i18n';
import { recipients } from '@/lib/weldbooks/invoice-activity';

/** The most invoices one call takes. */
export const BULK_REMIND_MAX = 100;

function BulkRemindResultDialog({
  result,
  labelOf,
  onClose,
}: Readonly<{ result: BulkRemindResult | null; labelOf: (invoiceId: string) => string; onClose: () => void }>) {
  const { t } = useI18n();
  const copy = t.weldbooksSales.bulk;
  const reasons = copy.reasons as Readonly<Record<string, string>>;
  const sent = result?.sent ?? [];
  const skipped = result?.skipped ?? [];
  return (
    <Dialog open={result !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{copy.resultTitle}</DialogTitle>
          <DialogDescription>
            {sent.length > 0 ? plural(sent.length, copy.sentSummary, getLocale()) : copy.nothingSent}
          </DialogDescription>
        </DialogHeader>
        {sent.length > 0 ? (
          <section aria-label={copy.sentHeading}>
            <h3 className="mb-1 text-sm font-semibold">{copy.sentHeading}</h3>
            <ul className="m-0 list-none space-y-1 p-0 text-[13px]" data-testid="bulk-sent">
              {sent.map((entry) => (
                <li key={entry.messageId}>
                  {copy.sentLine
                    .replace('{level}', String(entry.level))
                    .replace('{to}', recipients(entry.to))
                    .replace('{invoices}', entry.invoiceIds.map(labelOf).join(', '))}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {skipped.length > 0 ? (
          <section aria-label={copy.skippedHeading}>
            <h3 className="mb-1 text-sm font-semibold">{copy.skippedHeading}</h3>
            <ul className="m-0 list-none space-y-1 p-0 text-[13px] text-muted-foreground" data-testid="bulk-skipped">
              {skipped.map((entry) => (
                <li key={`${entry.invoiceId}-${entry.reason}`}>
                  {copy.skippedLine
                    .replace('{invoice}', labelOf(entry.invoiceId))
                    .replace('{reason}', reasons[entry.reason] ?? copy.reasonUnknown)}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {copy.close}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface BulkRemind {
  /** Asks to send reminders for these invoices (confirms first). */
  start: (invoiceIds: string[]) => void;
  pending: boolean;
  /** The confirmation and the result dialogs: render them once on the page. */
  dialogs: ReactNode;
}

/**
 * @param labelOf   the invoice's number, for the summary (an id the list no longer holds reads as itself)
 * @param onDone    called once the call went through, e.g. to clear the selection
 */
export function useBulkRemind(labelOf: (invoiceId: string) => string, onDone?: () => void): BulkRemind {
  const { t } = useI18n();
  const copy = t.weldbooksSales.bulk;
  const remind = useRemindBulk();
  const [asking, setAsking] = useState<string[] | null>(null);
  const [result, setResult] = useState<BulkRemindResult | null>(null);

  const run = () => {
    const ids = asking;
    if (!ids) return;
    remind.mutate(ids, {
      onSuccess: (res) => {
        setAsking(null);
        setResult(res.data);
        onDone?.();
      },
      onError: (error) => {
        setAsking(null);
        toast.error(copy.failed, { description: error instanceof Error ? error.message : undefined });
      },
    });
  };

  return {
    start: (ids) => setAsking(ids.slice(0, BULK_REMIND_MAX)),
    pending: remind.isPending,
    dialogs: (
      <>
        <ConfirmDialog
          open={asking !== null}
          onOpenChange={(open) => !open && setAsking(null)}
          title={plural(asking?.length ?? 0, copy.confirmTitle, getLocale())}
          description={copy.confirmDescription}
          confirmLabel={copy.send}
          cancelLabel={copy.cancel}
          loading={remind.isPending}
          onConfirm={run}
        />
        <BulkRemindResultDialog result={result} labelOf={labelOf} onClose={() => setResult(null)} />
      </>
    ),
  };
}
