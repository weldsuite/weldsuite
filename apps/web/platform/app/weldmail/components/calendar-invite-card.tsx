import { useEffect, useState } from 'react';
import { CalendarPlus, Check, Clock, MapPin, Loader2, CalendarX, CalendarDays, FileDown } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import {
  useCreateCalendarEvent,
  useUserCalendars,
  type CalendarEvent,
} from '@/hooks/queries/use-calendar-queries';
import { parseIcs, type ParsedIcsEvent } from '../lib/parse-ics';

interface CalendarInviteCardProps {
  /** Direct (already-authenticated) URL to the .ics attachment. */
  downloadUrl: string;
  /** Attachment id — used as a cache/dedupe key across re-renders. */
  attachmentId: string;
  /** File name of the .ics — shown on the fallback download chip. */
  fileName: string;
  /** Byte size of the attachment — shown on the fallback download chip. */
  size: number;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1048576) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1048576).toFixed(1)} MB`;
}

function formatEventWhen(event: ParsedIcsEvent): string {
  if (!event.start) return '';
  const start = new Date(event.start);
  if (isNaN(start.getTime())) return '';

  if (event.allDay) {
    return format(start, 'EEE, MMM d, yyyy');
  }

  const end = event.end ? new Date(event.end) : undefined;
  const startStr = format(start, 'EEE, MMM d, yyyy · HH:mm');
  if (!end || isNaN(end.getTime())) return startStr;

  const sameDay = start.toDateString() === end.toDateString();
  return sameDay
    ? `${startStr} – ${format(end, 'HH:mm')}`
    : `${startStr} – ${format(end, 'EEE, MMM d, yyyy · HH:mm')}`;
}

/**
 * Renders a calendar invite (`.ics` attachment) as an actionable card with a
 * one-click "Add to Weld Calendar" button. Fetches + parses the ICS on mount;
 * falls back silently (renders nothing) if the payload isn't a real VEVENT so
 * the plain attachment link still shows.
 */
export function CalendarInviteCard({ downloadUrl, attachmentId, fileName, size }: CalendarInviteCardProps) {
  const { t } = useI18n();
  const [event, setEvent] = useState<ParsedIcsEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [added, setAdded] = useState(false);

  const createEvent = useCreateCalendarEvent();
  const { data: calendarsData } = useUserCalendars();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setEvent(null);
    (async () => {
      try {
        const res = await fetch(downloadUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const parsed = parseIcs(text);
        if (!cancelled) setEvent(parsed);
      } catch {
        if (!cancelled) setEvent(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [downloadUrl, attachmentId]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-gray-200 dark:border-border bg-gray-50/60 dark:bg-card text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>{t.mail.messageDetail.calendarInviteLoading}</span>
      </div>
    );
  }

  // Couldn't read/parse the invite (e.g. CORS-blocked download, malformed ICS).
  // Fall back to a plain download chip so the attachment is never lost.
  if (!event) {
    return (
      <a
        href={downloadUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 dark:border-border bg-white dark:bg-card hover:bg-gray-50 dark:hover:bg-secondary transition-colors text-sm group"
      >
        <FileDown className="h-4 w-4 text-gray-400 group-hover:text-gray-600" />
        <span className="text-gray-700 truncate max-w-[200px]">{fileName}</span>
        <span className="text-gray-400 text-xs whitespace-nowrap">{formatBytes(size)}</span>
      </a>
    );
  }

  const isCancelled = event.method === 'CANCEL' || event.status === 'CANCELLED';
  const when = formatEventWhen(event);

  const handleAdd = () => {
    if (!event.start) {
      toast.error(t.mail.messageDetail.calendarInviteFailed);
      return;
    }

    // Prefer the user's default (or first writable) calendar; the backend also
    // resolves a default when calendarId is omitted, so this is best-effort.
    const calendars = calendarsData?.data ?? [];
    const writable = calendars.filter(
      (c) => c.isOwn || c.permission === 'edit' || c.permission === 'manage',
    );
    const target = writable.find((c) => c.isDefault) ?? writable[0];

    const payload: Partial<CalendarEvent> = {
      calendarId: target?.id,
      type: 'meeting',
      title: event.summary || t.mail.messageDetail.calendarInviteUntitled,
      description: event.description || undefined,
      startTime: event.start,
      endTime: event.end || undefined,
      allDay: event.allDay || undefined,
      location: event.location || undefined,
      status: 'confirmed',
      recurrenceRule: event.rrule || undefined,
      attendees: event.attendees
        .filter((a) => a.email)
        .map((a) => ({ email: a.email as string, name: a.name, status: 'pending' })),
      sourceType: 'email',
    };

    createEvent.mutate(payload, {
      onSuccess: () => {
        setAdded(true);
        toast.success(t.mail.messageDetail.calendarInviteAdded);
      },
      onError: () => {
        toast.error(t.mail.messageDetail.calendarInviteFailed);
      },
    });
  };

  return (
    <div
      className={cn(
        'rounded-lg border p-3 space-y-2.5',
        isCancelled
          ? 'border-red-200 dark:border-red-500/30 bg-red-50/50 dark:bg-red-950/20'
          : 'border-blue-200 dark:border-blue-500/30 bg-blue-50/50 dark:bg-blue-950/20',
      )}
    >
      <div className="flex items-start gap-2.5">
        <div
          className={cn(
            'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md',
            isCancelled ? 'bg-red-100 dark:bg-red-500/20' : 'bg-blue-100 dark:bg-blue-500/20',
          )}
        >
          {isCancelled ? (
            <CalendarX className="h-4 w-4 text-red-600 dark:text-red-400" />
          ) : (
            <CalendarDays className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {isCancelled
              ? t.mail.messageDetail.calendarInviteCancelledLabel
              : t.mail.messageDetail.calendarInviteLabel}
          </div>
          <div className="truncate text-sm font-semibold text-foreground">
            {event.summary || t.mail.messageDetail.calendarInviteUntitled}
          </div>
          {when && (
            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="truncate">{when}</span>
            </div>
          )}
          {event.location && (
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <MapPin className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="truncate">{event.location}</span>
            </div>
          )}
        </div>
      </div>

      {!isCancelled && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={added ? 'outline' : 'default'}
            onClick={handleAdd}
            disabled={added || createEvent.isPending}
            className="h-8"
          >
            {createEvent.isPending ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : added ? (
              <Check className="mr-1.5 h-3.5 w-3.5" />
            ) : (
              <CalendarPlus className="mr-1.5 h-3.5 w-3.5" />
            )}
            {added
              ? t.mail.messageDetail.calendarInviteAddedButton
              : t.mail.messageDetail.calendarInviteAddButton}
          </Button>
        </div>
      )}
    </div>
  );
}
