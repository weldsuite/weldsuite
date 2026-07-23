import { useState } from 'react';
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
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Label } from '@weldsuite/ui/components/label';
import { getTranslations } from '@/lib/i18n';

interface EventNotificationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (sendNotification: boolean) => void;
  isPending?: boolean;
  variant: 'delete' | 'update';
}

export function EventNotificationDialog({ open, onOpenChange, onConfirm, isPending, variant }: EventNotificationDialogProps) {
  const [sendNotification, setSendNotification] = useState(true);
  const t = getTranslations('weldcalendar');

  const isDelete = variant === 'delete';

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{isDelete ? t.eventNotification.deleteTitle : t.eventNotification.updateTitle}</AlertDialogTitle>
          <AlertDialogDescription>
            {isDelete
              ? t.eventNotification.deleteDescription
              : t.eventNotification.updateDescription}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex items-center gap-2 py-2">
          <Checkbox
            id="send-event-notification"
            checked={sendNotification}
            onCheckedChange={(v) => setSendNotification(v === true)}
          />
          <Label htmlFor="send-event-notification" className="text-sm font-normal cursor-pointer">
            {isDelete
              ? t.eventNotification.sendCancellationEmail
              : t.eventNotification.sendUpdateEmail}
          </Label>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>{t.eventNotification.cancel}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => onConfirm(sendNotification)}
            disabled={isPending}
            className={isDelete ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : ''}
          >
            {isPending
              ? (isDelete ? t.eventNotification.deleting : t.eventNotification.savingChanges)
              : (isDelete ? t.eventNotification.deleteConfirm : t.eventNotification.updateConfirm)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
