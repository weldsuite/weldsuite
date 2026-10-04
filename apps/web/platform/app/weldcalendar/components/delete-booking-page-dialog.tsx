import { useEffect, useState } from 'react';
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
import {
  useBookingPageDeleteImpact,
  useDeleteBookingPage,
} from '@/hooks/queries/use-calendar-queries';
import { getTranslations } from '@/lib/i18n';

interface DeleteBookingPageDialogProps {
  /** The booking page to delete; the dialog is open while this is set. */
  bookingPage: { id: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
  /** Called after the page is deleted, with its id (e.g. to leave its open view). */
  onDeleted?: (id: string) => void;
}

/**
 * Confirms deleting a booking page (TASK-893). States how many upcoming bookings
 * exist and that the public link and the guests' reschedule/cancel links stop
 * working.
 */
export function DeleteBookingPageDialog({
  bookingPage,
  onOpenChange,
  onDeleted,
}: Readonly<DeleteBookingPageDialogProps>) {
  const t = getTranslations('weldcalendar');
  // The last page shown, so the text does not blank out while closing.
  const [shown, setShown] = useState(bookingPage);
  const impact = useBookingPageDeleteImpact(bookingPage?.id ?? null);
  const deleteBookingPage = useDeleteBookingPage();

  useEffect(() => {
    if (bookingPage) setShown(bookingPage);
  }, [bookingPage]);

  const name = shown?.name ?? '';
  const upcoming = impact.data?.data.upcomingBookingCount;

  let impactLine: string;
  if (impact.isError) impactLine = t.deleteBookingPage.impactUnknown;
  else if (upcoming === undefined) impactLine = t.deleteBookingPage.counting;
  else if (upcoming === 0) impactLine = t.deleteBookingPage.noUpcoming;
  else if (upcoming === 1) impactLine = t.deleteBookingPage.oneUpcoming;
  else impactLine = t.deleteBookingPage.upcoming.replace('{count}', String(upcoming));

  const handleConfirm = async (e: React.MouseEvent) => {
    // Keep the dialog open until the request settles.
    e.preventDefault();
    if (!bookingPage) return;
    try {
      await deleteBookingPage.mutateAsync(bookingPage.id);
      toast.success(t.deleteBookingPage.deleted.replace('{name}', bookingPage.name));
      onOpenChange(false);
      onDeleted?.(bookingPage.id);
    } catch {
      toast.error(t.deleteBookingPage.failed);
    }
  };

  const isPending = deleteBookingPage.isPending;

  return (
    <AlertDialog open={!!bookingPage} onOpenChange={(open) => { if (!isPending) onOpenChange(open); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t.deleteBookingPage.title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>{t.deleteBookingPage.description.replace('{name}', name)}</p>
              <p className="font-medium text-foreground">{impactLine}</p>
              <p>{t.deleteBookingPage.linksStopWorking}</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>{t.deleteBookingPage.cancel}</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={isPending || impact.isLoading}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isPending ? t.deleteBookingPage.deleting : t.deleteBookingPage.confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
