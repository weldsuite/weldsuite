
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@weldsuite/ui/components/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { DateTimeField } from './date-time-field';
import { LocationAutocomplete } from './location-autocomplete';
import { GuestSearchInput } from './guest-search-input';
import {
  useCreateCalendarEvent,
  useUpdateCalendarEvent,
  useDeleteCalendarEvent,
  type CalendarEvent,
  type CalendarEventInput,
  type CalendarEventSaveResult,
  type UserCalendar,
} from '@/hooks/queries/use-calendar-queries';
import {
  buildEventFormSchema,
  getEventPriorityOptions,
  getEventStatusOptions,
  getEventTypeOptions,
  type EventFormValues,
  type EventFormInput,
} from '../lib/event-form-schema';
import {
  useAutoCreateWeldMeeting,
  WeldMeetCreateError,
  DEFAULT_WELDMEET_SETTINGS,
} from '@/hooks/use-auto-create-weld-meeting';
import { EventNotificationDialog } from './event-notification-dialog';
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
import { normalizeEventTimes } from '../lib/event-times';
import { useTimeFormat } from '../lib/calendar-format';

interface EventDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  event?: CalendarEvent | null;
  defaultStart?: Date;
  defaultEnd?: Date;
  defaultType?: string;
  /** Pre-fill the title field when creating a new event. */
  defaultTitle?: string;
  /** Pre-fill the description field when creating a new event. */
  defaultDescription?: string;
  calendars?: UserCalendar[];
  defaultCalendarId?: string;
  /** Called after the edited event was deleted from inside the dialog. */
  onDeleted?: () => void;
}

type FormAttendee = NonNullable<EventFormInput['attendees']>[number];

const isValidDate = (d: Date | null | undefined): d is Date => d instanceof Date && !Number.isNaN(d.getTime());

/** The browser's IANA zone ("Europe/Amsterdam"), sent so the server knows how to render the event's times. */
function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** Server rows carry `null` for unset columns; the form wants `undefined`. */
function toFormAttendees(attendees: CalendarEvent['attendees'] | null | undefined): FormAttendee[] {
  return (attendees ?? []).map((a) => ({
    email: a.email,
    name: a.name ?? undefined,
    status: a.status ?? undefined,
    role: a.role ?? undefined,
  }));
}

/** Every message in react-hook-form's (possibly nested) error object, prefixed with its field label. */
function collectErrorMessages(errors: unknown, label: string, out: string[] = []): string[] {
  if (!errors || typeof errors !== 'object') return out;
  const record = errors as Record<string, unknown>;
  if (typeof record.message === 'string' && record.message) {
    out.push(label ? `${label}: ${record.message}` : record.message);
    return out;
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === 'ref' || key === 'root') continue;
    collectErrorMessages(value, label, out);
  }
  return out;
}

export function EventDialog({ open, onOpenChange, event, defaultStart, defaultEnd, defaultType, defaultTitle, defaultDescription, calendars, defaultCalendarId, onDeleted }: Readonly<EventDialogProps>) {
  const isEdit = !!event?.id;
  const t = getTranslations('weldcalendar');
  const timeFormat = useTimeFormat();

  const createEvent = useCreateCalendarEvent();
  const updateEvent = useUpdateCalendarEvent();
  const deleteEvent = useDeleteCalendarEvent();
  const { saveEventWithWeldMeet } = useAutoCreateWeldMeeting();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  // Guestless event: nobody to notify, but deleting still asks first.
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);
  const [pendingPayload, setPendingPayload] = useState<CalendarEventInput | null>(null);
  // The virtual-meeting switch only marks the event as WeldMeet: the meeting
  // is created when the form is submitted, so cancelling leaves no orphan.
  const [addWeldMeet, setAddWeldMeet] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef(false);
  // Guests picker (same people search as the quick-create card).
  const [guestsActive, setGuestsActive] = useState(false);
  const [guestSearch, setGuestSearch] = useState('');
  const [guestIds, setGuestIds] = useState<string[]>([]);

  // Calendars the user can create events in (own + edit/manage shared)
  const writableCalendars = (calendars || []).filter((c) => c.isOwn || c.permission === 'edit' || c.permission === 'manage');

  // Validation messages in the user's language.
  const schema = useMemo(
    () =>
      buildEventFormSchema({
        calendarRequired: t.eventDialog.calendarRequired,
        titleRequired: t.eventDialog.titleRequired,
        titleTooLong: t.eventDialog.titleTooLong,
        startRequired: t.eventDialog.startRequired,
        invalidMeetingUrl: t.eventDialog.invalidMeetingUrl,
        invalidGuestEmail: t.eventDialog.invalidGuestEmail,
      }),
    [t.eventDialog],
  );
  // Type / priority / status names: the toolbar filter's, so a type has one name everywhere.
  const typeOptions = getEventTypeOptions(t.calendarView);
  const priorityOptions = getEventPriorityOptions(t.calendarView);
  const statusOptions = getEventStatusOptions(t.calendarView);

  const form = useForm<EventFormInput, unknown, EventFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      calendarId: defaultCalendarId || '',
      title: '',
      description: '',
      type: 'meeting',
      startTime: defaultStart || new Date(),
      endTime: defaultEnd || null,
      allDay: false,
      location: '',
      isVirtual: false,
      meetingUrl: '',
      status: 'confirmed',
      priority: 'normal',
      color: '',
      notes: '',
      attendees: [],
    },
  });

  // Reset the form whenever the dialog opens or its subject changes, so a
  // cancelled edit never leaks into the next time the dialog is opened.
  useEffect(() => {
    if (!open) return;
    setAddWeldMeet(false);
    setGuestsActive(false);
    setGuestSearch('');
    setGuestIds([]);
    if (event) {
      form.reset({
        calendarId: event.calendarId || defaultCalendarId || '',
        title: event.title || '',
        description: event.description || '',
        type: event.type || 'meeting',
        startTime: event.startTime ? new Date(event.startTime) : new Date(),
        endTime: event.endTime ? new Date(event.endTime) : null,
        allDay: event.allDay || false,
        location: event.location || '',
        isVirtual: event.isVirtual || false,
        meetingUrl: event.meetingUrl || '',
        status: (event.status as EventFormValues['status']) || 'confirmed',
        priority: (event.priority as EventFormValues['priority']) || 'normal',
        color: event.color || '',
        notes: event.notes || '',
        // The API returns null for unset columns; keep them out of the form.
        attendees: toFormAttendees(event.attendees),
        tags: event.tags ?? undefined,
        customerId: event.customerId ?? undefined,
        contactId: event.contactId ?? undefined,
      });
    } else {
      form.reset({
        calendarId: defaultCalendarId || '',
        title: defaultTitle || '',
        description: defaultDescription || '',
        type: (defaultType as EventFormValues['type']) || 'meeting',
        startTime: defaultStart || new Date(),
        endTime: defaultEnd || null,
        allDay: false,
        location: '',
        isVirtual: false,
        meetingUrl: '',
        status: 'confirmed',
        priority: 'normal',
        color: '',
        notes: '',
        attendees: [],
      });
    }
  }, [open, event, defaultStart, defaultEnd, defaultType, defaultTitle, defaultDescription, defaultCalendarId, form]);

  const attendees: FormAttendee[] = form.watch('attendees') ?? [];
  const hasAttendees = !!(isEdit && event?.attendees?.length);

  const addGuest = (guest: { id: string; name: string; email: string }) => {
    const email = guest.email.trim();
    if (!email) {
      toast.error(t.eventDialog.guestNoEmail);
      return;
    }
    if (attendees.some((a) => a.email.toLowerCase() === email.toLowerCase())) return;
    // A typed address arrives with the email as its name: store no name then
    // (like the quick-create card), so the guest is not shown as "a@b.c / a@b.c".
    const name = guest.name && guest.name.trim().toLowerCase() !== email.toLowerCase() ? guest.name : undefined;
    form.setValue('attendees', [...attendees, { email, name }], { shouldDirty: true });
    setGuestIds((ids) => [...ids, guest.id]);
    setGuestSearch('');
  };

  const removeGuest = (email: string) => {
    form.setValue(
      'attendees',
      attendees.filter((a) => a.email.toLowerCase() !== email.toLowerCase()),
      { shouldDirty: true },
    );
  };

  /**
   * Saves the event through `save`. With WeldMeet added the meeting is created
   * first and linked to the event by the same request (see
   * `saveEventWithWeldMeet`).
   */
  const persistEvent = async (
    payload: CalendarEventInput,
    save: (data: CalendarEventInput) => Promise<CalendarEventSaveResult>,
  ): Promise<void> => {
    if (!addWeldMeet || payload.meetingUrl || !payload.startTime) {
      await save(payload);
      return;
    }
    await saveEventWithWeldMeet({
      title: payload.title ?? '',
      start: payload.startTime,
      end: payload.endTime,
      attendees: payload.attendees?.map((a) => ({ email: a.email, name: a.name })),
      settings: DEFAULT_WELDMEET_SETTINGS,
      saveEvent: (url, weldMeetingId) => save({ ...payload, meetingUrl: url, isVirtual: true, weldMeetingId }),
    });
  };

  /** Runs one save with the double-submit guard; a meeting that failed to create was already reported. */
  const runSave = async (action: () => Promise<void>): Promise<boolean> => {
    if (savingRef.current) return false;
    savingRef.current = true;
    setIsSaving(true);
    try {
      await action();
      return true;
    } catch (err) {
      if (!(err instanceof WeldMeetCreateError)) toast.error(t.eventDialog.saveFailed);
      return false;
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  };

  const onSubmit = async (values: EventFormValues) => {
    const times = normalizeEventTimes(values.startTime, values.endTime, values.allDay);
    if (!times.ok) {
      form.setError(times.error === 'invalid-start' ? 'startTime' : 'endTime', {
        type: 'validate',
        message: times.error === 'invalid-start' ? t.eventDialog.invalidStart : t.eventDialog.endBeforeStart,
      });
      return;
    }

    // Editing: '' (not undefined) is what clears a value the user emptied.
    const clearable = (next: string | null | undefined, previous: string | null | undefined) =>
      next || (isEdit && previous ? '' : undefined);

    const guests = (values.attendees ?? []).map((a) => ({
      email: a.email,
      name: a.name ?? undefined,
      status: a.status ?? undefined,
      role: a.role ?? undefined,
    }));

    const payload: CalendarEventInput = {
      calendarId: values.calendarId || defaultCalendarId,
      title: values.title,
      type: values.type,
      status: values.status,
      priority: values.priority,
      allDay: values.allDay,
      startTime: times.start.toISOString(),
      endTime: times.end ? times.end.toISOString() : undefined,
      timezone: browserTimeZone(),
      isVirtual: values.isVirtual,
      meetingUrl: clearable(values.meetingUrl, event?.meetingUrl),
      location: clearable(values.location, event?.location),
      description: clearable(values.description, event?.description),
      notes: values.notes || undefined,
      color: values.color || undefined,
      customerId: values.customerId ?? undefined,
      contactId: values.contactId ?? undefined,
      tags: values.tags ?? undefined,
      // Edit sends the full list (an empty one removes everyone); create only when there are guests.
      attendees: isEdit || guests.length ? guests : undefined,
    };

    if (isEdit && event?.id) {
      if (hasAttendees || guests.length > 0) {
        // Added / removed guests count too: the dialog is how the user decides
        // whether they are mailed. The meeting is created after it is answered.
        setPendingPayload(payload);
        setShowUpdateDialog(true);
        return;
      }
      const eventId = event.id;
      const saved = await runSave(() =>
        persistEvent(payload, async (data) => (await updateEvent.mutateAsync({ id: eventId, data })).data),
      );
      if (saved) onOpenChange(false);
    } else {
      const saved = await runSave(() =>
        persistEvent(payload, async (data) => (await createEvent.mutateAsync(data)).data),
      );
      if (saved) onOpenChange(false);
    }
  };

  const handleUpdateConfirm = async (sendNotification: boolean) => {
    if (!event?.id || !pendingPayload) return;
    const eventId = event.id;
    const payload = pendingPayload;
    const saved = await runSave(() =>
      persistEvent(payload, async (data) => (await updateEvent.mutateAsync({ id: eventId, data, sendNotification })).data),
    );
    if (saved) {
      setPendingPayload(null);
      setShowUpdateDialog(false);
      onOpenChange(false);
    }
  };

  const handleDelete = async (sendNotification?: boolean) => {
    if (!event?.id) return;
    try {
      await deleteEvent.mutateAsync({ id: event.id, sendNotification });
    } catch {
      toast.error(t.eventPreview.deleteFailed);
      return;
    }
    onDeleted?.();
    onOpenChange(false);
  };

  const fieldLabels: Record<string, string> = {
    calendarId: t.eventDialog.calendarLabel,
    title: t.eventDialog.titleLabel,
    startTime: t.eventDialog.startLabel,
    endTime: t.eventDialog.endLabel,
    meetingUrl: t.eventDialog.meetingUrlLabel,
    attendees: t.eventDialog.guestsLabel,
  };
  // Title and the time fields show their error inline; everything else (a
  // field the dialog has no spot for, or a stale value from the server) would
  // otherwise block the submit without a word.
  const errorMessages = Object.entries(form.formState.errors).flatMap(([field, err]) =>
    field === 'title' || field === 'endTime' || field === 'startTime'
      ? []
      : collectErrorMessages(err, fieldLabels[field] ?? ''),
  );

  const isLoading = createEvent.isPending || updateEvent.isPending || deleteEvent.isPending || isSaving;

  let submitLabel: string;
  if (isLoading) {
    submitLabel = t.eventDialog.saving;
  } else if (isEdit) {
    submitLabel = t.eventDialog.update;
  } else {
    submitLabel = t.eventDialog.create;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[540px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? t.eventDialog.titleEdit : t.eventDialog.titleNew}</DialogTitle>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          {/* Calendar selector */}
          {writableCalendars.length > 1 && (
            <div className="space-y-2">
              <Label>{t.eventDialog.calendarLabel}</Label>
              <Select
                value={form.watch('calendarId')}
                onValueChange={(v) => form.setValue('calendarId', v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t.eventDialog.calendarPlaceholder} />
                </SelectTrigger>
                <SelectContent>
                  {writableCalendars.map((cal) => (
                    <SelectItem key={cal.id} value={cal.id}>
                      <div className="flex items-center gap-2">
                        <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: cal.color || '#3b82f6' }} />
                        {cal.name}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Title */}
          <div className="space-y-2">
            <Label htmlFor="title">{t.eventDialog.titleLabel}</Label>
            <Input
              id="title"
              placeholder={t.eventDialog.titlePlaceholder}
              {...form.register('title')}
            />
            {form.formState.errors.title && (
              <p className="text-sm text-destructive">{form.formState.errors.title.message}</p>
            )}
          </div>

          {/* Type & Status */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t.eventDialog.typeLabel}</Label>
              <Select
                value={form.watch('type')}
                onValueChange={(v) => form.setValue('type', v as EventFormValues['type'])}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {typeOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t.eventDialog.priorityLabel}</Label>
              <Select
                value={form.watch('priority')}
                onValueChange={(v) => form.setValue('priority', v as EventFormValues['priority'])}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {priorityOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* All Day toggle */}
          <div className="flex items-center gap-2">
            <Switch
              checked={form.watch('allDay')}
              onCheckedChange={(v) => form.setValue('allDay', v)}
            />
            <Label>{t.eventDialog.allDayLabel}</Label>
          </div>

          {/* Start / End Time */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label id="startTime-label" htmlFor="startTime">{t.eventDialog.startLabel}</Label>
              <DateTimeField
                id="startTime"
                labelId="startTime-label"
                value={form.watch('startTime')}
                allDay={!!form.watch('allDay')}
                timeFormat={timeFormat}
                invalid={!!form.formState.errors.startTime}
                onChange={(next) => {
                  const prev = form.getValues('startTime');
                  const end = form.getValues('endTime');
                  // Moving the start moves the end with it, so the duration is kept.
                  if (isValidDate(prev) && isValidDate(end)) {
                    form.setValue('endTime', new Date(end.getTime() + (next.getTime() - prev.getTime())), { shouldDirty: true });
                  }
                  form.setValue('startTime', next, { shouldDirty: true });
                  form.clearErrors(['startTime', 'endTime']);
                }}
              />
              {form.formState.errors.startTime && (
                <p className="text-sm text-destructive">{form.formState.errors.startTime.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label id="endTime-label" htmlFor="endTime">{t.eventDialog.endLabel}</Label>
              <DateTimeField
                id="endTime"
                labelId="endTime-label"
                value={form.watch('endTime')}
                fallback={form.watch('startTime')}
                allDay={!!form.watch('allDay')}
                timeFormat={timeFormat}
                invalid={!!form.formState.errors.endTime}
                onChange={(next) => {
                  form.setValue('endTime', next, { shouldDirty: true });
                  form.clearErrors('endTime');
                }}
              />
              {form.formState.errors.endTime && (
                <p className="text-sm text-destructive">{form.formState.errors.endTime.message}</p>
              )}
            </div>
          </div>

          {/* Location */}
          <div className="space-y-2">
            <Label htmlFor="location">{t.eventDialog.locationLabel}</Label>
            <LocationAutocomplete
              id="location"
              placeholder={t.eventDialog.locationPlaceholder}
              value={form.watch('location') || ''}
              onChange={(val) => form.setValue('location', val, { shouldDirty: true })}
            />
          </div>

          {/* Virtual meeting */}
          <div className="flex items-center gap-2">
            <Switch
              checked={form.watch('isVirtual')}
              onCheckedChange={(v) => {
                form.setValue('isVirtual', v);
                if (v) {
                  // No meeting is created here: it is created when the form is submitted.
                  if (!form.watch('meetingUrl')) setAddWeldMeet(true);
                } else {
                  form.setValue('meetingUrl', '');
                  setAddWeldMeet(false);
                }
              }}
            />
            <Label>{t.eventDialog.virtualLabel}</Label>
          </div>

          {form.watch('isVirtual') && (
            <div className="space-y-2">
              <Label htmlFor="meetingUrl">{t.eventDialog.meetingUrlLabel}</Label>
              {addWeldMeet && !form.watch('meetingUrl') ? (
                <div className="flex items-center h-9 px-3 rounded-md border bg-muted/50">
                  <span className="text-sm text-muted-foreground">{t.eventDialog.meetingLinkPending}</span>
                </div>
              ) : (
                <Input
                  id="meetingUrl"
                  placeholder={t.eventDialog.meetingUrlPlaceholder}
                  {...form.register('meetingUrl')}
                />
              )}
            </div>
          )}

          {/* Guests — same people search as the quick-create card */}
          <div className="space-y-2">
            <Label>{t.eventDialog.guestsLabel}</Label>
            {attendees.length > 0 && (
              <ul className="flex flex-wrap gap-1.5">
                {attendees.map((a) => (
                  <li
                    key={a.email}
                    className="inline-flex items-center gap-1 rounded-md bg-muted pl-2 pr-1 py-0.5 text-xs max-w-full"
                  >
                    <span className="truncate">{a.name || a.email}</span>
                    <button
                      type="button"
                      aria-label={t.eventDialog.removeGuest.replace('{name}', a.name || a.email)}
                      className="inline-flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
                      onClick={() => removeGuest(a.email)}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {guestsActive ? (
              // Enter picks a result; it must not also submit the form.
              <div
                className="rounded-md border px-3"
                onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
              >
                <GuestSearchInput
                  value={guestSearch}
                  onChange={setGuestSearch}
                  selectedIds={guestIds}
                  onSelect={addGuest}
                  onBlurAway={() => { setGuestsActive(false); setGuestSearch(''); }}
                />
              </div>
            ) : (
              <Button type="button" variant="outline" size="sm" className="shadow-none" onClick={() => setGuestsActive(true)}>
                <Plus className="h-3.5 w-3.5 mr-1" />
                {t.eventDialog.addGuests}
              </Button>
            )}
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="description">{t.eventDialog.descriptionLabel}</Label>
            <Textarea
              id="description"
              placeholder={t.eventDialog.descriptionPlaceholder}
              rows={3}
              {...form.register('description')}
            />
          </div>

          {/* Status (edit mode only) */}
          {isEdit && (
            <div className="space-y-2">
              <Label>{t.eventDialog.statusLabel}</Label>
              <Select
                value={form.watch('status')}
                onValueChange={(v) => form.setValue('status', v as EventFormValues['status'])}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {statusOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {errorMessages.length > 0 && (
            <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <p className="font-medium">{t.eventDialog.validationSummary}</p>
              <ul className="mt-1 list-disc pl-4">
                {errorMessages.map((m) => (<li key={m}>{m}</li>))}
              </ul>
            </div>
          )}

          <DialogFooter className="flex items-center justify-between">
            {isEdit && (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => hasAttendees ? setShowDeleteDialog(true) : setShowDeleteConfirm(true)}
                disabled={isLoading}
              >
                {t.eventDialog.delete}
              </Button>
            )}
            <div className="flex gap-2 ml-auto">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isLoading}>
                {t.eventDialog.cancel}
              </Button>
              <Button type="submit" disabled={isLoading}>
                {submitLabel}
              </Button>
            </div>
          </DialogFooter>
        </form>

        <EventNotificationDialog
          open={showDeleteDialog}
          onOpenChange={setShowDeleteDialog}
          onConfirm={async (sendNotification) => {
            await handleDelete(sendNotification);
            setShowDeleteDialog(false);
          }}
          isPending={deleteEvent.isPending}
          variant="delete"
        />
        <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t.eventPreview.deleteConfirmTitle}</AlertDialogTitle>
              <AlertDialogDescription>
                {t.eventPreview.deleteConfirmDescription.replace('{title}', event?.title || t.calendarView.untitled)}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleteEvent.isPending}>{t.eventPreview.deleteConfirmCancel}</AlertDialogCancel>
              <AlertDialogAction
                disabled={deleteEvent.isPending}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={async (e) => {
                  // Stay open until the request settled: a failure keeps the dialog (and the event) in view.
                  e.preventDefault();
                  await handleDelete();
                  setShowDeleteConfirm(false);
                }}
              >
                {deleteEvent.isPending ? t.eventPreview.deleting : t.eventPreview.deleteConfirmAction}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <EventNotificationDialog
          open={showUpdateDialog}
          onOpenChange={(open) => { if (!open) { setShowUpdateDialog(false); setPendingPayload(null); } }}
          onConfirm={handleUpdateConfirm}
          isPending={updateEvent.isPending}
          variant="update"
        />
      </DialogContent>
    </Dialog>
  );
}
