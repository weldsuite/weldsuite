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

interface CancelMeetingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (sendNotification: boolean) => void;
  isPending?: boolean;
}

export function CancelMeetingDialog({ open, onOpenChange, onConfirm, isPending }: CancelMeetingDialogProps) {
  const t = getTranslations('weldmeet');
  const [sendNotification, setSendNotification] = useState(true);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t.cancelMeeting.title}</AlertDialogTitle>
          <AlertDialogDescription>
            {t.cancelMeeting.description}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex items-center gap-2 py-2">
          <Checkbox
            id="send-notification"
            checked={sendNotification}
            onCheckedChange={(v) => setSendNotification(v === true)}
          />
          <Label htmlFor="send-notification" className="text-sm font-normal cursor-pointer">
            {t.cancelMeeting.sendNotification}
          </Label>
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>{t.cancelMeeting.keepMeeting}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => onConfirm(sendNotification)}
            disabled={isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isPending ? t.cancelMeeting.cancelling : t.cancelMeeting.cancel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
