/**
 * The suggested lock date of an entity (edition feature `books-questions`):
 * "You can lock up to 31 Oct", why that day, a chip to the item that stops a
 * later date, and "Use this date", which fills the period lock of the form
 * below. It only fills the field: nothing is saved until the member saves.
 */

import { CalendarCheck } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { RecordChip } from '@weldsuite/ui/components/record-chip';
import { RecordLink } from '@/components/object-panel/record-link';
import { isQuestionsAvailable, useLockDateSuggestion } from '@/hooks/queries/use-weldbooks-questions-queries';
import type { LockDateSuggestion } from '@/lib/api/domains/weldbooks-questions';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { toPublicPath } from '@/lib/workspace-url-rewrite';
import { withQuery } from '@/lib/with-query';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

/** The panel types a blocking item can open stacked. */
const PANEL_TYPES: ReadonlySet<string> = new Set(['bank_transaction', 'invoice', 'bill']);

function BlockingItem({ item }: Readonly<{ item: NonNullable<LockDateSuggestion['blockingItem']> }>) {
  const { t } = useI18n();
  const router = useRouter();
  const { formatDate } = useWeldbooksFormat();
  const tl = t.weldbooksQuestions.lock;
  const label = tl.blockingKinds[item.kind];
  const secondary = formatDate(item.date);

  if (PANEL_TYPES.has(item.objectType)) {
    return <RecordLink type={item.objectType as 'bank_transaction' | 'invoice' | 'bill'} id={item.objectId} label={label} secondary={secondary} />;
  }
  // An inbox document has no panel: it opens its dialog on the documents page.
  const href = withQuery('/weldbooks/documents', `document=${encodeURIComponent(item.objectId)}`);
  return <RecordChip label={label} secondary={secondary} href={toPublicPath(href)} onOpen={() => router.push(href)} />;
}

export function LockDateSuggestionBanner({
  entityId,
  onUse,
  disabled,
}: Readonly<{
  entityId: string;
  /** Fills the form's period lock with the date (`YYYY-MM-DD`); does not save. */
  onUse: (date: string) => void;
  disabled?: boolean;
}>) {
  const { t } = useI18n();
  const tl = t.weldbooksQuestions.lock;
  const { formatDate } = useWeldbooksFormat();
  const suggestion = useLockDateSuggestion(entityId, { enabled: !disabled });
  // A suggestion that cannot be made leaves the card as it was.
  if (!isQuestionsAvailable() || disabled || !suggestion.data) return null;
  const { suggestedDate, reason, blockingItem } = suggestion.data;

  return (
    <section
      className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-primary/20 bg-primary/5 p-4"
      aria-labelledby="lock-suggestion-title"
      data-testid="lock-suggestion"
    >
      <div className="min-w-0 flex-1 basis-64 space-y-1.5">
        <h3 id="lock-suggestion-title" className="flex items-center gap-2 text-sm font-semibold">
          <CalendarCheck className="size-4" aria-hidden />
          {tl.suggestion.replace('{date}', formatDate(suggestedDate))}
        </h3>
        <p className="text-xs text-muted-foreground">
          {tl.reasons[reason].replace('{date}', formatDate(blockingItem?.date ?? suggestedDate))}
        </p>
        {blockingItem ? (
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{tl.blockedBy}</span>
            <BlockingItem item={blockingItem} />
          </p>
        ) : null}
      </div>
      <Button type="button" size="sm" onClick={() => onUse(suggestedDate)} data-testid="lock-suggestion-use">
        {tl.useDate}
      </Button>
    </section>
  );
}
