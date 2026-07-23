
import { QuickCreateCard } from '../../components/calendar-view';
import { useUserCalendars } from '@/hooks/queries/use-calendar-queries';
import { cn } from '@/lib/utils';

interface NewEventDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-fill values when the dialog opens (e.g. from the customer panel). */
  defaults?: {
    title?: string;
    description?: string;
    location?: string;
    type?: string;
  };
  /** Hide the Event / Task / Reminder type tabs at the top of the card. */
  hideTypeTabs?: boolean;
}

/**
 * Renders the calendar view's `QuickCreateCard` (the same inline event
 * creation menu used in `/weldcalendar`) as a centered popup. No new design —
 * the menu IS the menu from the calendar view.
 */
export function NewEventDialog({ open, onOpenChange, defaults, hideTypeTabs }: NewEventDialogProps) {
  const { data: calendarsData } = useUserCalendars();
  const allCalendars = calendarsData?.data ?? [];
  const defaultCalendar =
    allCalendars.find((c) => c.isOwn && c.isDefault) ||
    allCalendars.find((c) => c.isOwn);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 animate-in fade-in-0"
        onClick={() => onOpenChange(false)}
      />
      {/* Card — same width / styling as the in-calendar QuickCreateCard. */}
      <div
        className={cn(
          'relative z-10 w-[360px] bg-popover border rounded-xl shadow-lg',
          'animate-in fade-in-0 zoom-in-95',
        )}
      >
        <QuickCreateCard
          defaultType={defaults?.type ?? 'event'}
          defaultTitle={defaults?.title}
          defaultDescription={defaults?.description}
          defaultLocation={defaults?.location}
          calendars={allCalendars}
          defaultCalendarId={defaultCalendar?.id}
          onClose={() => onOpenChange(false)}
          onMoreOptions={() => onOpenChange(false)}
          showTypeTabs={!hideTypeTabs}
        />
      </div>
    </div>
  );
}
