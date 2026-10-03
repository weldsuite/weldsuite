import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@weldsuite/ui/components/alert-dialog';
import { Button } from '@weldsuite/ui/components/button';
import { getTranslations } from '@/lib/i18n';

interface RescheduleNotifyDialogProps {
  open: boolean;
  /** Move the event and email the guests. */
  onSend: () => void;
  /** Move the event without emailing anyone. */
  onDontSend: () => void;
  /** Leave the event where it was. */
  onCancel: () => void;
}

/**
 * Asked once after dragging / resizing an event that has guests, before
 * anything is saved: one question instead of one email per adjustment.
 */
export function RescheduleNotifyDialog({ open, onSend, onDontSend, onCancel }: Readonly<RescheduleNotifyDialogProps>) {
  const t = getTranslations('weldcalendar');

  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t.rescheduleNotifyDialog.title}</AlertDialogTitle>
          <AlertDialogDescription>{t.rescheduleNotifyDialog.body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>{t.rescheduleNotifyDialog.cancel}</AlertDialogCancel>
          <Button type="button" variant="outline" onClick={onDontSend}>
            {t.rescheduleNotifyDialog.dontSend}
          </Button>
          <AlertDialogAction onClick={onSend}>{t.rescheduleNotifyDialog.send}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
