import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
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
import {
  useCalendarDeleteImpact,
  useDeleteUserCalendar,
  type UserCalendar,
} from '@/hooks/queries/use-calendar-queries';
import { getTranslations } from '@/lib/i18n';

interface DeleteCalendarDialogProps {
  /** The calendar to delete; the dialog is open while this is set. */
  calendar: Pick<UserCalendar, 'id' | 'name'> | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * Confirms deleting a calendar (TASK-745). States how many events go with it
 * and, when upcoming events have attendees, offers the same "send
 * cancellation email" choice an event delete does.
 */
export function DeleteCalendarDialog({ calendar, onOpenChange }: Readonly<DeleteCalendarDialogProps>) {
  const t = getTranslations('weldcalendar');
  const checkboxId = useId();
  const [sendNotification, setSendNotification] = useState(true);
  // The last calendar shown, so the text does not blank out while closing.
  const [shown, setShown] = useState(calendar);
  const impact = useCalendarDeleteImpact(calendar?.id ?? null);
  const deleteCalendar = useDeleteUserCalendar();

  // Each delete starts from the default (notify), like the event delete dialog.
  useEffect(() => {
    if (!calendar) return;
    setShown(calendar);
    setSendNotification(true);
  }, [calendar]);

  const name = shown?.name ?? '';
  const eventCount = impact.data?.data.eventCount;
  const withAttendees = impact.data?.data.eventsWithAttendees ?? 0;

  let description: string;
  if (impact.isError) description = t.deleteCalendar.descriptionAllEvents;
  else if (eventCount === undefined) description = t.deleteCalendar.countingEvents;
  else if (eventCount === 0) description = t.deleteCalendar.descriptionNoEvents;
  else if (eventCount === 1) description = t.deleteCalendar.descriptionOneEvent;
  else description = t.deleteCalendar.descriptionEvents.replace('{count}', String(eventCount));
  description = description.replace('{name}', name);

  const handleConfirm = async (e: React.MouseEvent) => {
    // Keep the dialog open until the request settles.
    e.preventDefault();
    if (!calendar) return;
    try {
      await deleteCalendar.mutateAsync({
        id: calendar.id,
        sendNotification: withAttendees > 0 && sendNotification,
      });
      toast.success(t.deleteCalendar.deleted.replace('{name}', name));
      onOpenChange(false);
    } catch {
      toast.error(t.deleteCalendar.failed);
    }
  };

  const isPending = deleteCalendar.isPending;

  return (
    <AlertDialog open={!!calendar} onOpenChange={(open) => { if (!isPending) onOpenChange(open); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t.deleteCalendar.title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>

        {withAttendees > 0 && (
          <div className="flex items-center gap-2 py-2">
            <Checkbox
              id={checkboxId}
              checked={sendNotification}
              onCheckedChange={(v) => setSendNotification(v === true)}
              disabled={isPending}
            />
            <Label htmlFor={checkboxId} className="text-sm font-normal cursor-pointer">
              {t.deleteCalendar.sendCancellationEmail.replace('{count}', String(withAttendees))}
            </Label>
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>{t.deleteCalendar.cancel}</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={isPending || impact.isLoading}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isPending ? t.deleteCalendar.deleting : t.deleteCalendar.confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
