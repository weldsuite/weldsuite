/**
 * The accountant's review mark on a booking (edition feature `books-questions`):
 * a chip that says whether a journal entry was reviewed, and the button that
 * marks or unmarks it. Used on the lines "Booked automatically" and on the
 * journal entry panel. The mark is not a ledger change: it needs
 * `journal:update` only.
 */

import { CheckCheck, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { isQuestionsAvailable, useSetJournalEntryReview } from '@/hooks/queries/use-weldbooks-questions-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

/** Whether this member sees the review marks: the edition has them and they may set them. */
export function useCanReview(): boolean {
  const { can } = usePermissions();
  return isQuestionsAvailable() && can('journal:update');
}

/** "Reviewed on 25 Nov" or "Not reviewed". The words carry the state, not the colour. */
export function ReviewChip({ reviewedAt }: Readonly<{ reviewedAt?: string | null }>) {
  const { t } = useI18n();
  const tr = t.weldbooksQuestions.review;
  const { formatDate } = useWeldbooksFormat();
  const reviewed = !!reviewedAt;
  return (
    <SoftBadge
      tone={reviewed ? 'success' : 'neutral'}
      data-testid="review-chip"
      data-reviewed={reviewed ? 'true' : 'false'}
      title={reviewedAt ? tr.reviewedOn.replace('{date}', formatDate(reviewedAt)) : undefined}
      className="gap-1"
    >
      {reviewed ? <CheckCheck className="size-3" aria-hidden /> : null}
      {reviewed ? tr.reviewed : tr.notReviewed}
    </SoftBadge>
  );
}

/** "Mark reviewed" or "Unmark" for one journal entry. Renders nothing for a member who may not. */
export function ReviewMarkButton({
  journalEntryId,
  reviewed,
  size = 'sm',
}: Readonly<{ journalEntryId: string; reviewed: boolean; size?: 'sm' | 'default' }>) {
  const { t } = useI18n();
  const tr = t.weldbooksQuestions.review;
  const canReview = useCanReview();
  const mutation = useSetJournalEntryReview();
  if (!canReview) return null;

  const toggle = () =>
    mutation.mutate(
      { journalEntryId, reviewed: !reviewed },
      {
        onSuccess: () => toast.success(reviewed ? tr.unmarkedToast : tr.markedToast),
        onError: (error) => toast.error(tr.failed, { description: error instanceof Error ? error.message : undefined }),
      },
    );

  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      disabled={mutation.isPending}
      onClick={toggle}
      data-testid={reviewed ? 'review-unmark' : 'review-mark'}
    >
      {reviewed ? <Undo2 className="size-4" aria-hidden /> : <CheckCheck className="size-4" aria-hidden />}
      {reviewed ? tr.unmark : tr.markReviewed}
    </Button>
  );
}
