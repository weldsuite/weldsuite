/** Approve or reject an expense declaration, with an optional note visible to the employee. */

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button, buttonVariants } from '@weldsuite/ui/components/button';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrDeclarationListItem } from '@weldsuite/app-api-client/domains/weldhr';
import { useReviewHrDeclaration } from '@/hooks/queries/use-weldhr-queries';
import { cn } from '@/lib/utils';
import { ErrorBanner, errorMessage, formatDate, formatMoney } from '../../components/shared';

export function DeclarationReviewDialog({
  declaration,
  decision,
  onClose,
}: Readonly<{
  declaration: HrDeclarationListItem;
  decision: 'approved' | 'rejected';
  onClose: () => void;
}>) {
  const t = useTranslations();
  const review = useReviewHrDeclaration();
  const [note, setNote] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  async function submit() {
    setFailure(null);
    try {
      await review.mutateAsync({ id: declaration.id, decision, note: note.trim() || null });
      onClose();
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.declarations.reviewFailed')));
    }
  }

  const action = decision === 'approved' ? t('weldhr.declarations.approve') : t('weldhr.declarations.reject');

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {action}
            {' · '}
            {declaration.employeeName}
          </DialogTitle>
          <DialogDescription>
            {formatMoney(declaration.amount, declaration.currency)}
            {' · '}
            {t(`weldhr.declarations.category.${declaration.category}`)}
            {' · '}
            {formatDate(declaration.expenseDate)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <ErrorBanner error={failure} />
          <p className="text-sm">{declaration.description}</p>
          <div className="space-y-1.5">
            <Label htmlFor="hr-declaration-review-note">{t('weldhr.declarations.reviewNoteLabel')}</Label>
            <Textarea
              id="hr-declaration-review-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('weldhr.declarations.reviewNotePlaceholder')}
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={review.isPending}>
            {t('weldhr.common.cancel')}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={review.isPending}
            className={cn(decision === 'rejected' && buttonVariants({ variant: 'destructive' }))}
          >
            {review.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
