import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import type { TaxDeadline } from '@/lib/api/domains/weldbooks-assets';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { fill } from '../../fixed-assets/text';

interface MarkDoneDialogProps {
  deadline: TaxDeadline;
  pending: boolean;
  error: string | null;
  onConfirm: (notes: string) => void;
  onCancel: () => void;
}

/** Mark a deadline done, with an optional note (a confirmation number, who filed it). */
export function MarkDoneDialog({ deadline, pending, error, onConfirm, onCancel }: Readonly<MarkDoneDialogProps>) {
  const { t } = useI18n();
  const tc = t.weldbooksUs.assets.taxCalendar;
  const common = t.weldbooksUs.assets.common;
  const { formatDate } = useWeldbooksFormat();
  const [notes, setNotes] = useState('');

  return (
    <Dialog open onOpenChange={(open) => (!open && !pending ? onCancel() : undefined)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{tc.markDoneTitle}</DialogTitle>
          <DialogDescription>
            {deadline.title} · {fill(tc.markDoneDue, { date: formatDate(deadline.dueDate) })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="deadline-notes">{tc.notes}</Label>
          <Textarea id="deadline-notes" rows={3} maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} />
          <p className="text-xs text-muted-foreground">{tc.notesHelp}</p>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
            {common.cancel}
          </Button>
          <Button type="button" onClick={() => onConfirm(notes.trim())} disabled={pending} data-testid="deadline-confirm">
            {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {tc.markDone}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
