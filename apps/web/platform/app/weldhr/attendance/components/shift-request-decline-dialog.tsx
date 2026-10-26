/** Decline a shift request, with an optional note the employee sees in the WeldHR app. */

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
import type { HrShiftRequest } from '@weldsuite/app-api-client/domains/weldhr';

export function ShiftRequestDeclineDialog({
  request,
  summary,
  onConfirm,
  onClose,
}: Readonly<{
  request: HrShiftRequest;
  /** The day and hours asked for, so the manager sees which request this is. */
  summary: string;
  /** Resolves true once the request is declined; the caller shows any failure itself. */
  onConfirm: (note: string | null) => Promise<boolean>;
  onClose: () => void;
}>) {
  const t = useTranslations();
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    const declined = await onConfirm(note.trim() || null);
    setSubmitting(false);
    if (declined) onClose();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !submitting && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('weldhr.attendance.requests.declineTitle')}</DialogTitle>
          <DialogDescription>
            {request.employeeName} · {summary}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="hr-shift-request-decline-note">{t('weldhr.attendance.requests.declineNoteLabel')}</Label>
          <Textarea
            id="hr-shift-request-decline-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('weldhr.attendance.requests.declineNotePlaceholder')}
            rows={3}
            maxLength={2000}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            {t('weldhr.common.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={submitting} className={buttonVariants({ variant: 'destructive' })}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('weldhr.attendance.requests.decline')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
