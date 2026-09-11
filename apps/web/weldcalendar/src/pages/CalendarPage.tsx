import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  startOfMonth,
  startOfWeek,
  startOfDay,
  endOfDay,
} from 'date-fns';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import type { Calendar, CalendarEvent } from '@weldsuite/personal-api-client';
import { personalApi } from '@/lib/api';
import { CALENDAR_COLORS, cn } from '@/lib/utils';

function toIso(d: Date) {
  return d.toISOString();
}

function eventStart(event: CalendarEvent): Date {
  return new Date(event.startTime);
}

export function CalendarPage() {
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [selected, setSelected] = useState(() => new Date());
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'closed' | 'create' | 'edit'>('closed');
  const [editing, setEditing] = useState<CalendarEvent | null>(null);

  const [title, setTitle] = useState('');
  const [calendarId, setCalendarId] = useState('');
  const [startLocal, setStartLocal] = useState('');
  const [endLocal, setEndLocal] = useState('');
  const [allDay, setAllDay] = useState(false);
  const [saving, setSaving] = useState(false);

  const rangeStart = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
  const rangeEnd = endOfWeek(endOfMonth(month), { weekStartsOn: 1 });
  const days = eachDayOfInterval({ start: rangeStart, end: rangeEnd });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [calRes, evRes] = await Promise.all([
        personalApi.calendars.list(),
        personalApi.calendarEvents.range({
          startDate: toIso(startOfDay(rangeStart)),
          endDate: toIso(endOfDay(rangeEnd)),
        }),
      ]);
      setCalendars(calRes.data);
      setEvents(evRes.data);
      if (!calendarId && calRes.data[0]) setCalendarId(calRes.data[0].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load calendar');
    } finally {
      setLoading(false);
    }
  }, [month]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void load();
  }, [load]);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of events) {
      if (event.status === 'cancelled') continue;
      const key = format(eventStart(event), 'yyyy-MM-dd');
      const list = map.get(key) ?? [];
      list.push(event);
      map.set(key, list);
    }
    return map;
  }, [events]);

  const dayEvents = eventsByDay.get(format(selected, 'yyyy-MM-dd')) ?? [];

  function openCreate(day?: Date) {
    const base = day ?? selected;
    setEditing(null);
    setTitle('');
    setAllDay(false);
    const start = new Date(base);
    start.setHours(9, 0, 0, 0);
    const end = new Date(base);
    end.setHours(10, 0, 0, 0);
    setStartLocal(format(start, "yyyy-MM-dd'T'HH:mm"));
    setEndLocal(format(end, "yyyy-MM-dd'T'HH:mm"));
    setCalendarId(calendars.find((c) => c.isDefault)?.id ?? calendars[0]?.id ?? '');
    setDialog('create');
  }

  function openEdit(event: CalendarEvent) {
    setEditing(event);
    setTitle(event.title);
    setAllDay(Boolean(event.allDay));
    setCalendarId(event.calendarId);
    const start = eventStart(event);
    const end = event.endTime ? new Date(event.endTime) : new Date(start.getTime() + 60 * 60 * 1000);
    setStartLocal(format(start, "yyyy-MM-dd'T'HH:mm"));
    setEndLocal(format(end, "yyyy-MM-dd'T'HH:mm"));
    setDialog('edit');
  }

  async function saveEvent() {
    if (!title.trim() || !calendarId) return;
    setSaving(true);
    try {
      const body = {
        calendarId,
        title: title.trim(),
        type: 'event' as const,
        startTime: new Date(startLocal).toISOString(),
        endTime: new Date(endLocal).toISOString(),
        allDay,
      };
      if (dialog === 'edit' && editing) {
        await personalApi.calendarEvents.update(editing.id, body);
      } else {
        await personalApi.calendarEvents.create(body);
      }
      setDialog('closed');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save event');
    } finally {
      setSaving(false);
    }
  }

  async function deleteEvent() {
    if (!editing) return;
    setSaving(true);
    try {
      await personalApi.calendarEvents.delete(editing.id);
      setDialog('closed');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete event');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[53px] shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-md p-1 hover:bg-muted"
            onClick={() => setMonth((m) => addMonths(m, -1))}
            aria-label="Previous month"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <h1 className="min-w-[160px] text-center text-sm font-semibold">
            {format(month, 'MMMM yyyy')}
          </h1>
          <button
            type="button"
            className="rounded-md p-1 hover:bg-muted"
            onClick={() => setMonth((m) => addMonths(m, 1))}
            aria-label="Next month"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <button
          type="button"
          onClick={() => openCreate()}
          className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"
        >
          <Plus className="h-4 w-4" />
          Event
        </button>
      </div>

      {error ? (
        <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto p-3">
          <div className="grid grid-cols-7 text-center text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
              <div key={d} className="py-1">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 border-l border-t border-border">
            {days.map((day) => {
              const key = format(day, 'yyyy-MM-dd');
              const items = eventsByDay.get(key) ?? [];
              const inMonth = isSameMonth(day, month);
              const active = isSameDay(day, selected);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSelected(day)}
                  onDoubleClick={() => openCreate(day)}
                  className={cn(
                    'min-h-[92px] border-b border-r border-border p-1.5 text-left align-top',
                    !inMonth && 'bg-muted/40 text-muted-foreground',
                    active && 'bg-accent',
                  )}
                >
                  <div
                    className={cn(
                      'mb-1 inline-flex h-6 w-6 items-center justify-center rounded-full text-xs',
                      isSameDay(day, new Date()) && 'bg-primary text-primary-foreground',
                    )}
                  >
                    {format(day, 'd')}
                  </div>
                  <div className="space-y-0.5">
                    {items.slice(0, 3).map((event) => (
                      <div
                        key={event.id}
                        className="truncate rounded px-1 text-[11px] text-white"
                        style={{
                          backgroundColor:
                            event.color ||
                            calendars.find((c) => c.id === event.calendarId)?.color ||
                            CALENDAR_COLORS[0],
                        }}
                      >
                        {event.title}
                      </div>
                    ))}
                    {items.length > 3 ? (
                      <div className="text-[10px] text-muted-foreground">+{items.length - 3} more</div>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </div>
          {loading ? (
            <p className="mt-3 text-center text-sm text-muted-foreground">Loading…</p>
          ) : null}
        </div>

        <aside className="w-[280px] shrink-0 overflow-y-auto border-l border-border p-4">
          <h2 className="text-sm font-semibold">{format(selected, 'EEEE, MMM d')}</h2>
          <div className="mt-3 space-y-2">
            {dayEvents.length === 0 ? (
              <p className="text-sm text-muted-foreground">No events</p>
            ) : (
              dayEvents.map((event) => (
                <button
                  key={event.id}
                  type="button"
                  onClick={() => openEdit(event)}
                  className="w-full rounded-md border border-border px-3 py-2 text-left hover:bg-muted"
                >
                  <div className="text-sm font-medium">{event.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {event.allDay
                      ? 'All day'
                      : `${format(eventStart(event), 'HH:mm')}${
                          event.endTime ? ` – ${format(new Date(event.endTime), 'HH:mm')}` : ''
                        }`}
                  </div>
                </button>
              ))
            )}
          </div>
        </aside>
      </div>

      {dialog !== 'closed' ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-border bg-background p-4 shadow-lg">
            <h2 className="text-sm font-semibold">
              {dialog === 'edit' ? 'Edit event' : 'New event'}
            </h2>
            <div className="mt-3 space-y-3">
              <label className="block text-xs font-medium text-muted-foreground">
                Title
                <input
                  className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <label className="block text-xs font-medium text-muted-foreground">
                Calendar
                <select
                  className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={calendarId}
                  onChange={(e) => setCalendarId(e.target.value)}
                  disabled={dialog === 'edit'}
                >
                  {calendars.map((cal) => (
                    <option key={cal.id} value={cal.id}>
                      {cal.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={allDay}
                  onChange={(e) => setAllDay(e.target.checked)}
                />
                All day
              </label>
              <label className="block text-xs font-medium text-muted-foreground">
                Starts
                <input
                  type="datetime-local"
                  className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={startLocal}
                  onChange={(e) => setStartLocal(e.target.value)}
                />
              </label>
              <label className="block text-xs font-medium text-muted-foreground">
                Ends
                <input
                  type="datetime-local"
                  className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={endLocal}
                  onChange={(e) => setEndLocal(e.target.value)}
                />
              </label>
            </div>
            <div className="mt-4 flex justify-between">
              {dialog === 'edit' ? (
                <button
                  type="button"
                  className="text-sm text-destructive"
                  onClick={() => void deleteEvent()}
                  disabled={saving}
                >
                  Delete
                </button>
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  className="h-9 rounded-md px-3 text-sm"
                  onClick={() => setDialog('closed')}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-60"
                  onClick={() => void saveEvent()}
                  disabled={saving || !title.trim()}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
