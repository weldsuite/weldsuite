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

/**
 * What is about to happen to an event that has guests:
 * - `delete`: the event is removed;
 * - `update`: its details change;
 * - `cancel`: it stays on the calendar, marked cancelled;
 * - `restore`: a cancelled event is on again.
 */
export type EventNotificationVariant = 'delete' | 'update' | 'cancel' | 'restore';

interface EventNotificationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (sendNotification: boolean) => void;
  isPending?: boolean;
  variant: EventNotificationVariant;
}

export function EventNotificationDialog({ open, onOpenChange, onConfirm, isPending, variant }: Readonly<EventNotificationDialogProps>) {
  const [sendNotification, setSendNotification] = useState(true);
  const t = getTranslations('weldcalendar').eventNotification;

  const copy = {
    delete: {
      title: t.deleteTitle,
      description: t.deleteDescription,
      checkbox: t.sendCancellationEmail,
      confirm: t.deleteConfirm,
      pending: t.deleting,
      dismiss: t.cancel,
      destructive: true,
    },
    update: {
      title: t.updateTitle,
      description: t.updateDescription,
      checkbox: t.sendUpdateEmail,
      confirm: t.updateConfirm,
      pending: t.savingChanges,
      dismiss: t.cancel,
      destructive: false,
    },
    cancel: {
      title: t.cancelEventTitle,
      description: t.cancelEventDescription,
      checkbox: t.sendCancellationEmail,
      confirm: t.cancelEventConfirm,
      pending: t.savingChanges,
      // "Cancel" next to "Cancel event" would read as the same action.
      dismiss: t.cancelEventDismiss,
      destructive: true,
    },
    restore: {
      title: t.restoreEventTitle,
      description: t.restoreEventDescription,
      checkbox: t.sendRestoredEmail,
      confirm: t.updateConfirm,
      pending: t.savingChanges,
      dismiss: t.cancel,
      destructive: false,
    },
  }[variant];

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription>{copy.description}</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex items-center gap-2 py-2">
          <Checkbox
            id="send-event-notification"
            checked={sendNotification}
            onCheckedChange={(v) => setSendNotification(v === true)}
          />
          <Label htmlFor="send-event-notification" className="text-sm font-normal cursor-pointer">
            {copy.checkbox}
          </Label>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>{copy.dismiss}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => onConfirm(sendNotification)}
            disabled={isPending}
            className={copy.destructive ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : ''}
          >
            {isPending ? copy.pending : copy.confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
