/**
 * Create/edit form for a calendar event.
 *
 * Mirrors TaskForm's chrome in WeldFlow (labelled fields, bottom-sheet
 * pickers, a platform-native date/time picker) so the two apps feel like one
 * product. What is calendar-specific:
 *
 *  - the calendar picker only offers calendars you may WRITE to. A calendar
 *    shared with `view` shows up on the Calendars tab and in the agenda, but
 *    the create route rejects an event aimed at it, so offering it here would
 *    only produce a 403 after the user filled the whole form in.
 *  - date and time are separate taps. One `datetime` picker is a fiddly
 *    two-column spinner on iOS and does not exist at all on Android, where
 *    `@react-native-community/datetimepicker` renders one mode at a time.
 *  - toggling "all day" snaps the start to 00:00 and the end to 23:59 of the
 *    same day, matching what the platform dialog writes.
 */

import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Calendar as CalIcon, Check, ChevronDown, Clock, MapPin, Video } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { BRAND, eventColor } from '@/lib/brand';
import { endOfDay, formatTime, startOfDay } from '@/lib/date';
import { eventTypeLabel, priorityLabel, statusLabel, useI18n } from '@/lib/i18n';
import { calendarPickerLabel } from '@/lib/calendar-access';
import { EventStatusBadge, EventTypeChip } from './status-badge';
import {
  EVENT_PRIORITIES,
  EVENT_STATUSES,
  EVENT_TYPES,
  type Calendar,
  type CreateEventInput,
  type EventPriority,
  type EventStatus,
  type EventType,
  type UpdateEventInput,
} from '@/types/weldcalendar';

export interface EventFormValues {
  calendarId: string;
  title: string;
  description: string;
  type: EventType;
  start: Date;
  end: Date;
  allDay: boolean;
  location: string;
  meetingUrl: string;
  status: EventStatus;
  priority: EventPriority;
  /** Edit mode only — drives `?sendNotification=true` on the PATCH. */
  notifyAttendees: boolean;
}

interface Props {
  mode: 'create' | 'edit';
  /** Only calendars the caller may write to; the picker offers these. */
  calendars: Calendar[];
  initialValues?: Partial<EventFormValues>;
  onSubmit: (values: EventFormValues) => Promise<void> | void;
  isSubmitting?: boolean;
  /** True when the event already has attendees, so the notify switch matters. */
  hasAttendees?: boolean;
}

type PickerType =
  | null
  | 'calendar'
  | 'type'
  | 'status'
  | 'priority'
  | 'startDate'
  | 'startTime'
  | 'endDate'
  | 'endTime';

/** Next whole hour — the slot a person almost always means by "now-ish". */
function defaultStart(): Date {
  const date = new Date();
  date.setMinutes(0, 0, 0);
  date.setHours(date.getHours() + 1);
  return date;
}

/** Copy the y/m/d of `date` onto `base`, leaving the clock alone. */
function withDate(base: Date, date: Date): Date {
  const next = new Date(base);
  next.setFullYear(date.getFullYear(), date.getMonth(), date.getDate());
  return next;
}

/** Copy the clock of `time` onto `base`, leaving the calendar day alone. */
function withTime(base: Date, time: Date): Date {
  const next = new Date(base);
  next.setHours(time.getHours(), time.getMinutes(), 0, 0);
  return next;
}

export function EventForm({
  mode,
  calendars,
  initialValues,
  onSubmit,
  isSubmitting = false,
  hasAttendees = false,
}: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { t, intlLocale } = useI18n();

  const initialStart = initialValues?.start ?? defaultStart();
  const initialEnd =
    initialValues?.end ?? new Date(initialStart.getTime() + 60 * 60 * 1000);

  const [calendarId, setCalendarId] = useState(
    initialValues?.calendarId ?? calendars[0]?.id ?? '',
  );
  const [title, setTitle] = useState(initialValues?.title ?? '');
  const [description, setDescription] = useState(initialValues?.description ?? '');
  const [type, setType] = useState<EventType>(initialValues?.type ?? 'meeting');
  const [start, setStart] = useState<Date>(initialStart);
  const [end, setEnd] = useState<Date>(initialEnd);
  const [allDay, setAllDay] = useState(initialValues?.allDay ?? false);
  const [location, setLocation] = useState(initialValues?.location ?? '');
  const [meetingUrl, setMeetingUrl] = useState(initialValues?.meetingUrl ?? '');
  const [status, setStatus] = useState<EventStatus>(initialValues?.status ?? 'confirmed');
  const [priority, setPriority] = useState<EventPriority>(initialValues?.priority ?? 'normal');
  const [notifyAttendees, setNotifyAttendees] = useState(
    initialValues?.notifyAttendees ?? false,
  );

  const [titleError, setTitleError] = useState<string | null>(null);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [picker, setPicker] = useState<PickerType>(null);

  const selectedCalendar = useMemo(
    () => calendars.find((c) => c.id === calendarId),
    [calendars, calendarId],
  );

  const formatDay = (date: Date) =>
    date.toLocaleDateString(intlLocale, { weekday: 'short', day: 'numeric', month: 'short' });

  /**
   * All-day snaps the pair to the day's bounds. Turning it back off restores a
   * sane 09:00–10:00 rather than leaving 00:00–23:59 behind, which is never
   * what someone wants from a timed event.
   */
  const handleAllDayChange = (next: boolean) => {
    setAllDay(next);
    setRangeError(null);
    if (next) {
      setStart(startOfDay(start));
      setEnd(endOfDay(end.getTime() < start.getTime() ? start : end));
    } else {
      const nextStart = withTime(start, new Date(2000, 0, 1, 9, 0));
      setStart(nextStart);
      setEnd(new Date(nextStart.getTime() + 60 * 60 * 1000));
    }
  };

  /** Dragging the start forward carries the end with it, preserving duration. */
  const applyStart = (nextStart: Date) => {
    const duration = Math.max(end.getTime() - start.getTime(), 0);
    setStart(nextStart);
    setEnd(new Date(nextStart.getTime() + duration));
    setRangeError(null);
  };

  const handlePickerChange = (kind: PickerType) => (_event: unknown, selected?: Date) => {
    if (Platform.OS === 'android') setPicker(null);
    if (!selected) return;
    switch (kind) {
      case 'startDate':
        applyStart(withDate(start, selected));
        break;
      case 'startTime':
        applyStart(withTime(start, selected));
        break;
      case 'endDate':
        setEnd(withDate(end, selected));
        setRangeError(null);
        break;
      case 'endTime':
        setEnd(withTime(end, selected));
        setRangeError(null);
        break;
      default:
        break;
    }
  };

  const pickerValue = (): Date => {
    if (picker === 'startDate' || picker === 'startTime') return start;
    return end;
  };

  const pickerMode = (): 'date' | 'time' =>
    picker === 'startTime' || picker === 'endTime' ? 'time' : 'date';

  const handleSubmit = async () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setTitleError(t.eventForm.titleRequired);
      return;
    }
    if (end.getTime() <= start.getTime()) {
      setRangeError(t.eventForm.endBeforeStart);
      return;
    }
    setTitleError(null);
    setRangeError(null);
    await onSubmit({
      calendarId,
      title: trimmed,
      description: description.trim(),
      type,
      start,
      end,
      allDay,
      location: location.trim(),
      meetingUrl: meetingUrl.trim(),
      status,
      priority,
      notifyAttendees,
    });
  };

  if (calendars.length === 0) {
    return (
      <View style={styles.container}>
        <Text style={[styles.emptyState, { color: colors.mutedForeground }]}>
          {t.eventForm.noWritableCalendar}
        </Text>
      </View>
    );
  }

  const fieldStyle = {
    color: colors.text,
    backgroundColor: colors.cardBackground,
    borderColor: colors.divider,
  };

  return (
    <View style={styles.container}>
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.muted }]}>{t.eventForm.titleLabel}</Text>
        <TextInput
          style={[
            styles.input,
            fieldStyle,
            titleError ? { borderColor: colors.destructive } : null,
          ]}
          placeholder={t.eventForm.titlePlaceholder}
          placeholderTextColor={colors.muted}
          value={title}
          onChangeText={(value) => {
            setTitle(value);
            if (titleError) setTitleError(null);
          }}
          returnKeyType="next"
          autoFocus={mode === 'create'}
        />
        {titleError ? (
          <Text style={[styles.errorText, { color: colors.destructive }]}>{titleError}</Text>
        ) : null}
      </View>

      <View style={styles.row}>
        <View style={[styles.field, styles.rowCol]}>
          <Text style={[styles.label, { color: colors.muted }]}>
            {t.eventForm.calendarLabel}
          </Text>
          <TouchableOpacity
            style={[styles.pickerButton, fieldStyle]}
            onPress={() => setPicker('calendar')}
            accessibilityRole="button"
          >
            <View style={styles.iconLeft}>
              <View
                style={[
                  styles.swatch,
                  { backgroundColor: selectedCalendar?.color || BRAND },
                ]}
              />
              <Text style={[styles.pickerText, { color: colors.text }]} numberOfLines={1}>
                {selectedCalendar
                  ? calendarPickerLabel(selectedCalendar, t.calendars.personal)
                  : t.common.notSet}
              </Text>
            </View>
            <ChevronDown size={18} color={colors.muted} />
          </TouchableOpacity>
        </View>

        <View style={[styles.field, styles.rowCol]}>
          <Text style={[styles.label, { color: colors.muted }]}>{t.eventForm.typeLabel}</Text>
          <TouchableOpacity
            style={[styles.pickerButton, fieldStyle]}
            onPress={() => setPicker('type')}
            accessibilityRole="button"
          >
            <EventTypeChip type={type} />
            <ChevronDown size={18} color={colors.muted} />
          </TouchableOpacity>
        </View>
      </View>

      <View style={[styles.switchRow, { backgroundColor: colors.cardBackground, borderColor: colors.divider }]}>
        <View style={styles.iconLeft}>
          <CalIcon size={18} color={colors.muted} />
          <Text style={[styles.switchLabel, { color: colors.text }]}>
            {t.eventForm.allDayLabel}
          </Text>
        </View>
        <Switch
          value={allDay}
          onValueChange={handleAllDayChange}
          trackColor={{ true: BRAND, false: colors.border }}
        />
      </View>

      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.muted }]}>{t.eventForm.startsLabel}</Text>
        <View style={styles.row}>
          <TouchableOpacity
            style={[styles.pickerButton, styles.rowCol, fieldStyle]}
            onPress={() => setPicker('startDate')}
            accessibilityRole="button"
            accessibilityLabel={t.eventForm.pickDate}
          >
            <Text style={[styles.pickerText, { color: colors.text }]}>{formatDay(start)}</Text>
            <ChevronDown size={18} color={colors.muted} />
          </TouchableOpacity>
          {!allDay ? (
            <TouchableOpacity
              style={[styles.pickerButton, styles.timeCol, fieldStyle]}
              onPress={() => setPicker('startTime')}
              accessibilityRole="button"
              accessibilityLabel={t.eventForm.pickTime}
            >
              <Clock size={16} color={colors.muted} />
              <Text style={[styles.pickerText, { color: colors.text }]}>
                {formatTime(start, intlLocale)}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.muted }]}>{t.eventForm.endsLabel}</Text>
        <View style={styles.row}>
          <TouchableOpacity
            style={[
              styles.pickerButton,
              styles.rowCol,
              fieldStyle,
              rangeError ? { borderColor: colors.destructive } : null,
            ]}
            onPress={() => setPicker('endDate')}
            accessibilityRole="button"
            accessibilityLabel={t.eventForm.pickDate}
          >
            <Text style={[styles.pickerText, { color: colors.text }]}>{formatDay(end)}</Text>
            <ChevronDown size={18} color={colors.muted} />
          </TouchableOpacity>
          {!allDay ? (
            <TouchableOpacity
              style={[
                styles.pickerButton,
                styles.timeCol,
                fieldStyle,
                rangeError ? { borderColor: colors.destructive } : null,
              ]}
              onPress={() => setPicker('endTime')}
              accessibilityRole="button"
              accessibilityLabel={t.eventForm.pickTime}
            >
              <Clock size={16} color={colors.muted} />
              <Text style={[styles.pickerText, { color: colors.text }]}>
                {formatTime(end, intlLocale)}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>
        {rangeError ? (
          <Text style={[styles.errorText, { color: colors.destructive }]}>{rangeError}</Text>
        ) : null}
      </View>

      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.muted }]}>{t.eventForm.locationLabel}</Text>
        <View style={[styles.inputWithIcon, fieldStyle]}>
          <MapPin size={16} color={colors.muted} />
          <TextInput
            style={[styles.inputInner, { color: colors.text }]}
            placeholder={t.eventForm.locationPlaceholder}
            placeholderTextColor={colors.muted}
            value={location}
            onChangeText={setLocation}
          />
        </View>
      </View>

      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.muted }]}>
          {t.eventForm.meetingUrlLabel}
        </Text>
        <View style={[styles.inputWithIcon, fieldStyle]}>
          <Video size={16} color={colors.muted} />
          <TextInput
            style={[styles.inputInner, { color: colors.text }]}
            placeholder={t.eventForm.meetingUrlPlaceholder}
            placeholderTextColor={colors.muted}
            value={meetingUrl}
            onChangeText={setMeetingUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
        </View>
      </View>

      <View style={styles.row}>
        <View style={[styles.field, styles.rowCol]}>
          <Text style={[styles.label, { color: colors.muted }]}>{t.eventForm.statusLabel}</Text>
          <TouchableOpacity
            style={[styles.pickerButton, fieldStyle]}
            onPress={() => setPicker('status')}
            accessibilityRole="button"
          >
            <EventStatusBadge status={status} />
            <ChevronDown size={18} color={colors.muted} />
          </TouchableOpacity>
        </View>

        <View style={[styles.field, styles.rowCol]}>
          <Text style={[styles.label, { color: colors.muted }]}>
            {t.eventForm.priorityLabel}
          </Text>
          <TouchableOpacity
            style={[styles.pickerButton, fieldStyle]}
            onPress={() => setPicker('priority')}
            accessibilityRole="button"
          >
            <Text style={[styles.pickerText, { color: colors.text }]}>
              {priorityLabel(t, priority)}
            </Text>
            <ChevronDown size={18} color={colors.muted} />
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.muted }]}>
          {t.eventForm.descriptionLabel}
        </Text>
        <TextInput
          style={[styles.input, styles.multiline, fieldStyle]}
          placeholder={t.eventForm.descriptionPlaceholder}
          placeholderTextColor={colors.muted}
          value={description}
          onChangeText={setDescription}
          multiline
          textAlignVertical="top"
        />
      </View>

      {mode === 'edit' && hasAttendees ? (
        <View
          style={[
            styles.switchRow,
            { backgroundColor: colors.cardBackground, borderColor: colors.divider },
          ]}
        >
          <Text style={[styles.switchLabel, { color: colors.text, flex: 1 }]}>
            {t.eventForm.notifyLabel}
          </Text>
          <Switch
            value={notifyAttendees}
            onValueChange={setNotifyAttendees}
            trackColor={{ true: BRAND, false: colors.border }}
          />
        </View>
      ) : null}

      <TouchableOpacity
        style={[styles.submitBtn, isSubmitting && styles.disabled]}
        onPress={handleSubmit}
        disabled={isSubmitting}
        accessibilityRole="button"
      >
        {isSubmitting ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <Text style={styles.submitText}>
            {mode === 'create' ? t.eventForm.submitCreate : t.eventForm.submitSave}
          </Text>
        )}
      </TouchableOpacity>

      {/* Option sheets — calendar / type / status / priority */}
      <OptionSheet
        visible={picker === 'calendar'}
        title={t.eventForm.calendarLabel}
        onClose={() => setPicker(null)}
        bottomInset={insets.bottom}
      >
        {calendars.map((calendar) => (
          <TouchableOpacity
            key={calendar.id}
            style={[styles.sheetOption, { borderBottomColor: colors.divider }]}
            onPress={() => {
              setCalendarId(calendar.id);
              setPicker(null);
            }}
          >
            <View style={styles.iconLeft}>
              <View style={[styles.swatch, { backgroundColor: calendar.color || BRAND }]} />
              <Text style={[styles.sheetOptionText, { color: colors.text }]}>
                {calendarPickerLabel(calendar, t.calendars.personal)}
              </Text>
            </View>
            {calendar.id === calendarId ? <Check size={18} color={BRAND} /> : null}
          </TouchableOpacity>
        ))}
      </OptionSheet>

      <OptionSheet
        visible={picker === 'type'}
        title={t.eventForm.typeLabel}
        onClose={() => setPicker(null)}
        bottomInset={insets.bottom}
      >
        {EVENT_TYPES.map((option) => (
          <TouchableOpacity
            key={option}
            style={[styles.sheetOption, { borderBottomColor: colors.divider }]}
            onPress={() => {
              setType(option);
              setPicker(null);
            }}
          >
            <View style={styles.iconLeft}>
              <View style={[styles.swatch, { backgroundColor: eventColor(null, option) }]} />
              <Text style={[styles.sheetOptionText, { color: colors.text }]}>
                {eventTypeLabel(t, option)}
              </Text>
            </View>
            {option === type ? <Check size={18} color={BRAND} /> : null}
          </TouchableOpacity>
        ))}
      </OptionSheet>

      <OptionSheet
        visible={picker === 'status'}
        title={t.eventForm.statusLabel}
        onClose={() => setPicker(null)}
        bottomInset={insets.bottom}
      >
        {EVENT_STATUSES.map((option) => (
          <TouchableOpacity
            key={option}
            style={[styles.sheetOption, { borderBottomColor: colors.divider }]}
            onPress={() => {
              setStatus(option);
              setPicker(null);
            }}
          >
            <Text style={[styles.sheetOptionText, { color: colors.text }]}>
              {statusLabel(t, option)}
            </Text>
            {option === status ? <Check size={18} color={BRAND} /> : null}
          </TouchableOpacity>
        ))}
      </OptionSheet>

      <OptionSheet
        visible={picker === 'priority'}
        title={t.eventForm.priorityLabel}
        onClose={() => setPicker(null)}
        bottomInset={insets.bottom}
      >
        {EVENT_PRIORITIES.map((option) => (
          <TouchableOpacity
            key={option}
            style={[styles.sheetOption, { borderBottomColor: colors.divider }]}
            onPress={() => {
              setPriority(option);
              setPicker(null);
            }}
          >
            <Text style={[styles.sheetOptionText, { color: colors.text }]}>
              {priorityLabel(t, option)}
            </Text>
            {option === priority ? <Check size={18} color={BRAND} /> : null}
          </TouchableOpacity>
        ))}
      </OptionSheet>

      {/* Date / time picker — iOS gets a sheet-wrapped spinner, Android the
          platform dialog, which dismisses itself via onChange. */}
      {picker === 'startDate' ||
      picker === 'startTime' ||
      picker === 'endDate' ||
      picker === 'endTime' ? (
        Platform.OS === 'ios' ? (
          <Modal visible transparent animationType="slide" onRequestClose={() => setPicker(null)}>
            <Pressable style={styles.backdrop} onPress={() => setPicker(null)}>
              <Pressable
                style={[
                  styles.sheet,
                  { backgroundColor: colors.cardBackground, paddingBottom: insets.bottom + 16 },
                ]}
                onPress={(event) => event.stopPropagation()}
              >
                <View style={styles.sheetHeader}>
                  <Text style={[styles.sheetTitle, { color: colors.text }]}>
                    {pickerMode() === 'date' ? t.eventForm.pickDate : t.eventForm.pickTime}
                  </Text>
                  <TouchableOpacity onPress={() => setPicker(null)}>
                    <Text style={[styles.sheetAction, { color: BRAND }]}>{t.common.done}</Text>
                  </TouchableOpacity>
                </View>
                <DateTimePicker
                  value={pickerValue()}
                  mode={pickerMode()}
                  display="spinner"
                  onChange={handlePickerChange(picker)}
                  themeVariant={colors.text === '#fff' ? 'dark' : 'light'}
                />
              </Pressable>
            </Pressable>
          </Modal>
        ) : (
          <DateTimePicker
            value={pickerValue()}
            mode={pickerMode()}
            display="default"
            onChange={handlePickerChange(picker)}
          />
        )
      ) : null}
    </View>
  );
}

/** Bottom sheet holding a list of single-select options. */
function OptionSheet({
  visible,
  title,
  onClose,
  bottomInset,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  bottomInset: number;
  children: React.ReactNode;
}) {
  const { colors } = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={[
            styles.sheet,
            {
              backgroundColor: colors.cardBackground,
              paddingBottom: bottomInset + 16,
              maxHeight: '75%',
            },
          ]}
          onPress={(event) => event.stopPropagation()}
        >
          <Text style={[styles.sheetTitle, { color: colors.text }]}>{title}</Text>
          <ScrollView>{children}</ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Payload mapping ────────────────────────────────────────────────────────

/**
 * `timezone` is stamped from the device so the platform can show where a
 * mobile-created event was scheduled from. The times themselves go over as
 * absolute ISO instants, so the column is descriptive, not load-bearing.
 */
function deviceTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export function toCreateEventInput(values: EventFormValues): CreateEventInput {
  return {
    calendarId: values.calendarId,
    title: values.title,
    description: values.description || undefined,
    type: values.type,
    startTime: values.start.toISOString(),
    endTime: values.end.toISOString(),
    allDay: values.allDay,
    timezone: deviceTimezone(),
    location: values.location || undefined,
    isVirtual: values.meetingUrl.length > 0,
    meetingUrl: values.meetingUrl || undefined,
    status: values.status,
    priority: values.priority,
  };
}

/**
 * `calendarId` is deliberately absent — the PATCH schema omits it, so an event
 * cannot change calendars through this form.
 */
export function toUpdateEventInput(values: EventFormValues): UpdateEventInput {
  return {
    title: values.title,
    description: values.description || undefined,
    type: values.type,
    startTime: values.start.toISOString(),
    endTime: values.end.toISOString(),
    allDay: values.allDay,
    timezone: deviceTimezone(),
    location: values.location || undefined,
    isVirtual: values.meetingUrl.length > 0,
    meetingUrl: values.meetingUrl || undefined,
    status: values.status,
    priority: values.priority,
  };
}

const styles = StyleSheet.create({
  container: { gap: 16 },
  field: { gap: 6 },
  row: { flexDirection: 'row', gap: 12 },
  rowCol: { flex: 1 },
  timeCol: { width: 116, justifyContent: 'center', gap: 8 },
  label: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  input: {
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 0.5,
  },
  inputWithIcon: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 0.5,
    minHeight: 46,
  },
  inputInner: { flex: 1, fontSize: 15, paddingVertical: 12 },
  multiline: { minHeight: 96, paddingTop: 12 },
  errorText: { fontSize: 12 },
  pickerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 0.5,
    minHeight: 46,
    gap: 8,
  },
  iconLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 },
  pickerText: { fontSize: 14, flexShrink: 1 },
  swatch: { width: 12, height: 12, borderRadius: 6, flexShrink: 0 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 0.5,
    minHeight: 52,
    gap: 12,
  },
  switchLabel: { fontSize: 15, fontWeight: '500' },
  submitBtn: {
    backgroundColor: BRAND,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  disabled: { opacity: 0.6 },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  emptyState: { fontSize: 14, textAlign: 'center', paddingVertical: 32, lineHeight: 20 },
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16 },
  sheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 8,
  },
  sheetTitle: { fontSize: 18, fontWeight: '700', marginBottom: 12 },
  sheetAction: { fontSize: 16, fontWeight: '600', marginBottom: 12 },
  sheetOption: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: 0.5,
    gap: 12,
  },
  sheetOptionText: { fontSize: 16, flexShrink: 1 },
});
