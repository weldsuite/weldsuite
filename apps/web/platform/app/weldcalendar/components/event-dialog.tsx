
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Trash2, Loader2 } from 'lucide-react';
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
import { LocationAutocomplete } from './location-autocomplete';
import {
  useCreateCalendarEvent,
  useUpdateCalendarEvent,
  useDeleteCalendarEvent,
  type CalendarEvent,
  type UserCalendar,
} from '@/hooks/queries/use-calendar-queries';
import {
  eventFormSchema,
  type EventFormValues,
  EVENT_TYPE_OPTIONS,
  EVENT_PRIORITY_OPTIONS,
  EVENT_STATUS_OPTIONS,
} from '../lib/event-form-schema';
import { useAutoCreateWeldMeeting } from '@/hooks/use-auto-create-weld-meeting';
import { EventNotificationDialog } from './event-notification-dialog';

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
}

function formatDateTimeLocal(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function EventDialog({ open, onOpenChange, event, defaultStart, defaultEnd, defaultType, defaultTitle, defaultDescription, calendars, defaultCalendarId }: EventDialogProps) {
  const isEdit = !!event?.id;
  const t = getTranslations('weldcalendar');

  const createEvent = useCreateCalendarEvent();
  const updateEvent = useUpdateCalendarEvent();
  const deleteEvent = useDeleteCalendarEvent();
  const { createMeetingAndGetUrl, isPending: isCreatingMeeting } = useAutoCreateWeldMeeting();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);
  const [pendingPayload, setPendingPayload] = useState<any>(null);

  // Calendars the user can create events in (own + edit/manage shared)
  const writableCalendars = (calendars || []).filter((c) => c.isOwn || c.permission === 'edit' || c.permission === 'manage');

  const form = useForm<EventFormValues>({
    resolver: zodResolver(eventFormSchema),
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
    },
  });

  // Reset form when event changes
  useEffect(() => {
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
        status: (event.status as any) || 'confirmed',
        priority: (event.priority as any) || 'normal',
        color: event.color || '',
        notes: event.notes || '',
        attendees: event.attendees,
        tags: event.tags,
      });
    } else {
      form.reset({
        calendarId: defaultCalendarId || '',
        title: defaultTitle || '',
        description: defaultDescription || '',
        type: (defaultType as any) || 'meeting',
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
      });
    }
  }, [event, defaultStart, defaultEnd, defaultType, defaultTitle, defaultDescription, form]);

  const hasAttendees = !!(isEdit && event?.attendees?.length);

  const onSubmit = async (values: EventFormValues) => {
    const payload = {
      ...values,
      calendarId: values.calendarId || defaultCalendarId,
      startTime: values.startTime.toISOString(),
      endTime: values.endTime ? values.endTime.toISOString() : undefined,
      meetingUrl: values.meetingUrl || undefined,
      location: values.location || undefined,
      description: values.description || undefined,
      notes: values.notes || undefined,
      color: values.color || undefined,
    };

    if (isEdit && event?.id) {
      if (hasAttendees) {
        setPendingPayload(payload);
        setShowUpdateDialog(true);
      } else {
        await updateEvent.mutateAsync({ id: event.id, data: payload });
        onOpenChange(false);
      }
    } else {
      await createEvent.mutateAsync(payload);
      onOpenChange(false);
    }
  };

  const handleUpdateConfirm = async (sendNotification: boolean) => {
    if (event?.id && pendingPayload) {
      await updateEvent.mutateAsync({ id: event.id, data: pendingPayload, sendNotification });
      setPendingPayload(null);
      setShowUpdateDialog(false);
      onOpenChange(false);
    }
  };

  const handleDelete = async (sendNotification?: boolean) => {
    if (event?.id) {
      await deleteEvent.mutateAsync({ id: event.id, sendNotification });
      onOpenChange(false);
    }
  };

  const isLoading = createEvent.isPending || updateEvent.isPending || deleteEvent.isPending || isCreatingMeeting;

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
                onValueChange={(v) => form.setValue('type', v as any)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EVENT_TYPE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t.eventDialog.priorityLabel}</Label>
              <Select
                value={form.watch('priority')}
                onValueChange={(v) => form.setValue('priority', v as any)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EVENT_PRIORITY_OPTIONS.map((opt) => (
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
              <Label htmlFor="startTime">{t.eventDialog.startLabel}</Label>
              <Input
                id="startTime"
                type={form.watch('allDay') ? 'date' : 'datetime-local'}
                value={form.watch('startTime') ? formatDateTimeLocal(form.watch('startTime')) : ''}
                onChange={(e) => form.setValue('startTime', new Date(e.target.value))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="endTime">{t.eventDialog.endLabel}</Label>
              <Input
                id="endTime"
                type={form.watch('allDay') ? 'date' : 'datetime-local'}
                value={form.watch('endTime') ? formatDateTimeLocal(form.watch('endTime')!) : ''}
                onChange={(e) => form.setValue('endTime', e.target.value ? new Date(e.target.value) : null)}
              />
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
              onCheckedChange={async (v) => {
                form.setValue('isVirtual', v);
                if (v && !form.watch('meetingUrl')) {
                  const result = await createMeetingAndGetUrl(form.watch('title') || 'Meeting');
                  if (result) {
                    form.setValue('meetingUrl', result.url);
                  } else {
                    form.setValue('isVirtual', false);
                  }
                } else if (!v) {
                  form.setValue('meetingUrl', '');
                }
              }}
              disabled={isCreatingMeeting}
            />
            <Label>{t.eventDialog.virtualLabel}</Label>
          </div>

          {form.watch('isVirtual') && (
            <div className="space-y-2">
              <Label htmlFor="meetingUrl">{t.eventDialog.meetingUrlLabel}</Label>
              {isCreatingMeeting ? (
                <div className="flex items-center gap-2 h-9 px-3 rounded-md border bg-muted/50">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">{t.eventDialog.creatingMeetingLink}</span>
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
                onValueChange={(v) => form.setValue('status', v as any)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EVENT_STATUS_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <DialogFooter className="flex items-center justify-between">
            {isEdit && (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => hasAttendees ? setShowDeleteDialog(true) : handleDelete()}
                disabled={isLoading}
              >
                <Trash2 className="h-4 w-4 mr-1" />
                {t.eventDialog.delete}
              </Button>
            )}
            <div className="flex gap-2 ml-auto">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isLoading}>
                {t.eventDialog.cancel}
              </Button>
              <Button type="submit" disabled={isLoading}>
                {isLoading ? t.eventDialog.saving : isEdit ? t.eventDialog.update : t.eventDialog.create}
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
