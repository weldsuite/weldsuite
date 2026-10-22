/**
 * The task sheet: create a task, read its details, edit it, change its status
 * and delete it. One modal with three modes so the screens only manage the list.
 * Same fields as the platform's task dialog: status, priority, due date,
 * assignees, the company or person it's about, labels and repeat.
 */

import React, { useEffect, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Calendar, ChevronRight, Edit3, Repeat, Trash2, X } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { DueDateField } from '@/components/due-date-field';
import { FormField } from '@/components/form';
import { MemberPicker, useMembers } from '@/components/member-picker';
import { OptionSheet, SelectField, TagInput } from '@/components/option-sheet';
import { RecordRefField } from '@/components/record-ref-field';
import { tasksApi, type CrmTask, type TaskInput } from '@/services/tasks';
import type { RecordRef } from '@/services/notes';
import { interpolate, useI18n } from '@/lib/i18n';
import {
  REPEAT_FREQUENCIES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  repeatInput,
  type RepeatFrequency,
  type TaskPriority,
  type TaskStatus,
} from '@/lib/crm';
import { formatDueLabel, parseDate, parseDateInput, toDateInput } from '@/lib/dates';
import { describeError, validateTask, type FormErrors } from '@/lib/validation';

export const TASK_STATUS_COLORS: Record<TaskStatus, { color: string; bgColor: string }> = {
  backlog: { color: '#6B7280', bgColor: '#F3F4F6' },
  todo: { color: '#6B7280', bgColor: '#F3F4F6' },
  in_progress: { color: '#3B82F6', bgColor: '#DBEAFE' },
  review: { color: '#CA8A04', bgColor: '#FEF9C3' },
  testing: { color: '#9333EA', bgColor: '#F3E8FF' },
  done: { color: '#10B981', bgColor: '#D1FAE5' },
  cancelled: { color: '#EF4444', bgColor: '#FEE2E2' },
};

export const TASK_PRIORITY_COLORS: Record<TaskPriority, string> = {
  low: '#6B7280',
  medium: '#3B82F6',
  high: '#F97316',
  urgent: '#EF4444',
};

export type TaskSheetMode = 'create' | 'view' | 'edit';

interface TaskSheetProps {
  visible: boolean;
  /** `create` opens an empty form; `view` shows `task`. */
  initialMode: TaskSheetMode;
  task: CrmTask | null;
  /** Create mode: the record the new task is for (a record's Tasks tab). */
  defaultRecord?: RecordRef;
  onClose: () => void;
  onCreated: (task: CrmTask) => void;
  onUpdated: (task: CrmTask) => void;
  onDeleted: (taskId: string) => void;
}

/** The API's error text when it sent one, else the screen's own message. */
function errorText(error: unknown, fallback: string): string {
  return typeof error === 'string' ? error : fallback;
}

interface FormState {
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority | null;
  dueDate: string;
  assigneeIds: string[];
  record?: RecordRef;
  labels: string[];
  repeat: RepeatFrequency | null;
}

function formFromTask(task: CrmTask | null, defaultRecord: RecordRef | undefined, userId: string | undefined): FormState {
  if (!task) {
    return {
      title: '',
      description: '',
      status: 'todo',
      priority: null,
      dueDate: '',
      // New tasks are yours unless you assign them to someone else, as on the web.
      assigneeIds: userId ? [userId] : [],
      record: defaultRecord,
      labels: [],
      repeat: null,
    };
  }
  return {
    title: task.title,
    description: task.description ?? '',
    status: task.status,
    priority: task.priority ?? null,
    dueDate: toDateInput(parseDate(task.dueDate)),
    assigneeIds: task.assignees.map((person) => person.id),
    record: task.record,
    labels: task.labels,
    repeat: task.repeat?.frequency ?? null,
  };
}

/** What to save; `original` is the task being edited (null when creating). */
function taskInputFrom(form: FormState, original: CrmTask | null): TaskInput {
  const due = parseDateInput(form.dueDate).date;
  return {
    title: form.title,
    description: form.description,
    // The form shows statuses it doesn't know as the nearest one; only send a status the user picked.
    status: original?.status === form.status ? undefined : form.status,
    priority: form.priority,
    dueDate: due ? due.toISOString() : null,
    assigneeIds: form.assigneeIds,
    record: form.record ?? null,
    labels: form.labels,
    repeat: repeatInput(form.repeat, original?.repeat),
  };
}

type SheetPicker = 'status' | 'priority' | 'repeat' | 'assignees' | null;

/** One labelled read-only value in the details view. */
function DetailSection({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  const { colors } = useTheme();
  return (
    <View style={styles.section}>
      <Text style={[styles.label, { color: colors.muted }]}>{label}</Text>
      {children}
    </View>
  );
}

export function TaskSheet({
  visible,
  initialMode,
  task,
  defaultRecord,
  onClose,
  onCreated,
  onUpdated,
  onDeleted,
}: Readonly<TaskSheetProps>) {
  const { colors } = useTheme();
  const { t, intlLocale } = useI18n();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const { user } = useClerkAuth();
  const { members, byId } = useMembers();

  const [mode, setMode] = useState<TaskSheetMode>(initialMode);
  const [form, setForm] = useState<FormState>(() => formFromTask(task, defaultRecord, user?.id));
  const [errors, setErrors] = useState<FormErrors<'title' | 'dueDate' | 'record'>>({});
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState<SheetPicker>(null);

  // Each time the sheet opens, start in the requested mode with the task's values (or empty).
  useEffect(() => {
    if (!visible) return;
    setMode(initialMode);
    setForm(formFromTask(task, defaultRecord, user?.id));
    setErrors({});
    setBusy(false);
    setPicker(null);
  }, [visible, initialMode, task, defaultRecord, user?.id]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((prev) => ({ ...prev, [key]: value }));

  const statusLabel = (status: TaskStatus) => t.tasks.status[status];
  const priorityLabel = (priority: TaskPriority) => t.tasks.priority[priority];
  const repeatLabel = (repeat: RepeatFrequency) => t.tasks.repeat[repeat];
  const assigneeNames = (ids: readonly string[]) =>
    ids.map((id) => byId.get(id)?.name ?? task?.assignees.find((a) => a.id === id)?.name ?? t.common.unknown).join(', ');

  // flow-api can't clear a priority once set, so don't offer "None" for one.
  const canClearPriority = mode === 'create' || !task?.priority;
  const clearPriority = canClearPriority ? () => set('priority', null) : undefined;

  const headings: Record<TaskSheetMode, string> = {
    create: t.tasks.newTitle,
    edit: t.tasks.editTitle,
    view: t.tasks.detailsTitle,
  };

  const handleSubmit = async () => {
    const found: FormErrors<'title' | 'dueDate' | 'record'> = {
      ...validateTask({ title: form.title, dueDate: form.dueDate }, parseDateInput),
      // The platform only saves CRM tasks that point at a company or a person.
      ...(form.record ? {} : { record: 'required' as const }),
    };
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const input = taskInputFrom(form, task && mode !== 'create' ? task : null);

    if (mode !== 'create' && !task) return;
    setBusy(true);
    const res = task && mode !== 'create' ? await tasksApi.update(task.id, input) : await tasksApi.create(input);
    setBusy(false);
    if (res.success && res.data) {
      if (mode === 'create') {
        toast.success(t.tasks.createdToast);
        onCreated(res.data);
      } else {
        toast.success(t.tasks.updatedToast);
        onUpdated(res.data);
        setMode('view');
      }
      return;
    }
    toast.error(errorText(res.error, mode === 'create' ? t.tasks.createFailed : t.tasks.updateFailed));
  };

  const changeStatus = async (next: TaskStatus) => {
    if (!task || next === task.status || busy) return;
    setBusy(true);
    const res = await tasksApi.update(task.id, { status: next });
    setBusy(false);
    if (res.success && res.data) onUpdated(res.data);
    else toast.error(errorText(res.error, t.tasks.updateFailed));
  };

  const confirmDelete = () => {
    if (!task) return;
    Alert.alert(t.tasks.deleteTitle, interpolate(t.tasks.deleteMessage, { title: task.title }), [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.common.delete,
        style: 'destructive',
        onPress: () => {
          void (async () => {
            setBusy(true);
            const res = await tasksApi.remove(task.id);
            setBusy(false);
            if (res.success) {
              toast.success(t.tasks.deletedToast);
              onDeleted(task.id);
            } else {
              toast.error(errorText(res.error, t.tasks.deleteFailed));
            }
          })();
        },
      },
    ]);
  };

  const openRecord = (record: RecordRef) => {
    onClose();
    router.push({
      pathname: record.kind === 'company' ? '/company/[id]' : '/person/[id]',
      params: { id: record.id, name: record.name ?? '' },
    });
  };

  const renderView = (current: CrmTask) => {
    const due = parseDate(current.dueDate);
    const statusColors = TASK_STATUS_COLORS[current.status];
    return (
      <ScrollView
        style={styles.body}
        contentContainerStyle={[styles.bodyContent, { paddingBottom: insets.bottom + 24 }]}
        showsVerticalScrollIndicator={false}
      >
        <DetailSection label={t.tasks.fieldTitle}>
          <Text style={[styles.taskTitle, { color: colors.text }]}>{current.title}</Text>
        </DetailSection>

        {!!current.description && (
          <DetailSection label={t.tasks.fieldDescription}>
            <Text style={[styles.text, { color: colors.text }]}>{current.description}</Text>
          </DetailSection>
        )}

        <DetailSection label={t.tasks.fieldStatus}>
          <TouchableOpacity
            style={[styles.statusButton, { backgroundColor: statusColors.bgColor, opacity: busy ? 0.6 : 1 }]}
            onPress={() => setPicker('status')}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={`${t.tasks.fieldStatus}: ${statusLabel(current.status)}`}
          >
            <Text style={[styles.statusButtonText, { color: statusColors.color }]}>{statusLabel(current.status)}</Text>
          </TouchableOpacity>
        </DetailSection>

        {!!current.priority && (
          <DetailSection label={t.tasks.fieldPriority}>
            <Text style={[styles.text, { color: TASK_PRIORITY_COLORS[current.priority] }]}>
              {priorityLabel(current.priority)}
            </Text>
          </DetailSection>
        )}

        {!!current.record && (
          <DetailSection label={t.tasks.fieldRecord}>
            <TouchableOpacity style={styles.row} onPress={() => openRecord(current.record as RecordRef)} accessibilityRole="link">
              <Text style={[styles.text, styles.link]}>
                {current.record.name || t.common.unknown}
              </Text>
              <ChevronRight size={14} color={colors.muted} />
            </TouchableOpacity>
          </DetailSection>
        )}

        {!!due && (
          <DetailSection label={t.tasks.fieldDueDate}>
            <View style={styles.row}>
              <Calendar size={16} color={colors.text} strokeWidth={2} />
              <Text style={[styles.text, { color: colors.text }]}>{formatDueLabel(due, t, intlLocale)}</Text>
            </View>
          </DetailSection>
        )}

        {!!current.repeat && (
          <DetailSection label={t.tasks.fieldRepeat}>
            <View style={styles.row}>
              <Repeat size={16} color={colors.text} strokeWidth={2} />
              <Text style={[styles.text, { color: colors.text }]}>{repeatLabel(current.repeat.frequency)}</Text>
            </View>
          </DetailSection>
        )}

        {current.assignees.length > 0 && (
          <DetailSection label={t.tasks.fieldAssignees}>
            <Text style={[styles.text, { color: colors.text }]}>{assigneeNames(current.assignees.map((a) => a.id))}</Text>
          </DetailSection>
        )}

        {current.labels.length > 0 && (
          <DetailSection label={t.tasks.fieldLabels}>
            <View style={styles.labels}>
              {current.labels.map((label) => (
                <View key={label} style={[styles.labelChip, { backgroundColor: colors.secondary }]}>
                  <Text style={[styles.labelText, { color: colors.text }]}>{label}</Text>
                </View>
              ))}
            </View>
          </DetailSection>
        )}

        <DetailSection label={t.tasks.fieldCreated}>
          <Text style={[styles.text, { color: colors.text }]}>
            {new Date(current.createdAt).toLocaleDateString(intlLocale, { day: 'numeric', month: 'long', year: 'numeric' })}
          </Text>
        </DetailSection>
      </ScrollView>
    );
  };

  const renderForm = () => {
    const submitLabel = mode === 'create' ? t.tasks.createTask : t.tasks.saveChanges;
    return (
      <>
        <ScrollView
          style={styles.body}
          contentContainerStyle={styles.bodyContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <FormField
            label={t.tasks.fieldTitle}
            required
            value={form.title}
            onChangeText={(value) => set('title', value)}
            placeholder={t.tasks.titlePlaceholder}
            error={errors.title ? describeError(t, errors.title, t.tasks.fieldTitle) : null}
            autoCapitalize="sentences"
          />
          <FormField
            label={t.tasks.fieldDescriptionOptional}
            value={form.description}
            onChangeText={(value) => set('description', value)}
            placeholder={t.tasks.descriptionPlaceholder}
            multiline
            numberOfLines={4}
          />
          <RecordRefField
            label={t.tasks.fieldRecord}
            value={form.record}
            onChange={(record) => set('record', record)}
            required
            error={errors.record ? describeError(t, errors.record, t.tasks.fieldRecord) : null}
          />
          <SelectField
            label={t.tasks.fieldStatus}
            value={statusLabel(form.status)}
            color={TASK_STATUS_COLORS[form.status].color}
            onPress={() => setPicker('status')}
          />
          <SelectField
            label={t.tasks.fieldPriority}
            value={form.priority ? priorityLabel(form.priority) : null}
            placeholder={t.tasks.noPriority}
            color={form.priority ? TASK_PRIORITY_COLORS[form.priority] : undefined}
            onPress={() => setPicker('priority')}
            onClear={clearPriority}
          />
          <DueDateField
            label={t.tasks.fieldDueDateOptional}
            value={form.dueDate}
            onChange={(value) => set('dueDate', value)}
            error={errors.dueDate ? describeError(t, errors.dueDate, t.tasks.fieldDueDate) : null}
          />
          <SelectField
            label={t.tasks.fieldAssignees}
            value={form.assigneeIds.length > 0 ? assigneeNames(form.assigneeIds) : null}
            placeholder={t.tasks.unassigned}
            onPress={() => setPicker('assignees')}
            onClear={() => set('assigneeIds', [])}
          />
          <SelectField
            label={t.tasks.fieldRepeat}
            value={form.repeat ? repeatLabel(form.repeat) : null}
            placeholder={t.tasks.repeatNever}
            onPress={() => setPicker('repeat')}
            onClear={() => set('repeat', null)}
          />
          <TagInput
            label={t.tasks.fieldLabels}
            value={form.labels}
            placeholder={t.tasks.labelsPlaceholder}
            onChange={(labels) => set('labels', labels)}
          />
        </ScrollView>
        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12), borderTopColor: colors.divider }]}>
          <TouchableOpacity
            style={[styles.submit, { backgroundColor: colors.text, opacity: busy ? 0.6 : 1 }]}
            onPress={() => void handleSubmit()}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={submitLabel}
          >
            {busy ? (
              <ActivityIndicator color={colors.background} />
            ) : (
              <Text style={[styles.submitText, { color: colors.background }]}>{submitLabel}</Text>
            )}
          </TouchableOpacity>
        </View>
      </>
    );
  };

  const currentStatus = mode === 'view' && task ? task.status : form.status;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={[styles.sheet, { backgroundColor: colors.background, paddingTop: insets.top }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={[styles.header, { borderBottomColor: colors.divider }]}>
          <Text style={[styles.headerTitle, { color: colors.text }]} accessibilityRole="header">
            {headings[mode]}
          </Text>
          <View style={styles.headerActions}>
            {mode === 'view' && task ? (
              <>
                <TouchableOpacity
                  onPress={() => {
                    setForm(formFromTask(task, defaultRecord, user?.id));
                    setMode('edit');
                  }}
                  style={styles.iconButton}
                  accessibilityRole="button"
                  accessibilityLabel={t.tasks.editTask}
                >
                  <Edit3 size={20} color={colors.text} />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={confirmDelete}
                  style={styles.iconButton}
                  accessibilityRole="button"
                  accessibilityLabel={t.tasks.deleteTask}
                >
                  <Trash2 size={20} color={colors.destructive} />
                </TouchableOpacity>
              </>
            ) : null}
            <TouchableOpacity onPress={onClose} style={styles.iconButton} accessibilityRole="button" accessibilityLabel={t.common.close}>
              <X size={20} color={colors.text} strokeWidth={2} />
            </TouchableOpacity>
          </View>
        </View>

        {mode === 'view' && task ? renderView(task) : null}
        {mode === 'view' ? null : renderForm()}

        <OptionSheet<TaskStatus>
          visible={picker === 'status'}
          title={t.tasks.fieldStatus}
          options={TASK_STATUSES.map((status) => ({
            value: status,
            label: statusLabel(status),
            color: TASK_STATUS_COLORS[status].color,
          }))}
          selected={currentStatus}
          onSelect={(value) => {
            setPicker(null);
            if (!value) return;
            if (mode === 'view') void changeStatus(value);
            else set('status', value);
          }}
          onClose={() => setPicker(null)}
        />
        <OptionSheet<TaskPriority>
          visible={picker === 'priority'}
          title={t.tasks.fieldPriority}
          options={TASK_PRIORITIES.map((priority) => ({
            value: priority,
            label: priorityLabel(priority),
            color: TASK_PRIORITY_COLORS[priority],
          }))}
          selected={form.priority}
          allowNone={canClearPriority}
          onSelect={(value) => {
            set('priority', value);
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
        <OptionSheet<RepeatFrequency>
          visible={picker === 'repeat'}
          title={t.tasks.fieldRepeat}
          options={REPEAT_FREQUENCIES.map((frequency) => ({ value: frequency, label: repeatLabel(frequency) }))}
          selected={form.repeat}
          allowNone
          onSelect={(value) => {
            set('repeat', value);
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
        <MemberPicker
          visible={picker === 'assignees'}
          title={t.tasks.fieldAssignees}
          members={members}
          selected={form.assigneeIds}
          multiple
          onChange={(ids) => set('assigneeIds', ids)}
          onClose={() => setPicker(null)}
        />
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingLeft: 16,
    paddingRight: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { fontSize: 17, fontWeight: '600' },
  headerActions: { flexDirection: 'row', alignItems: 'center' },
  iconButton: { padding: 8 },
  body: { flex: 1 },
  bodyContent: { padding: 20, paddingBottom: 32 },
  section: { marginBottom: 20 },
  label: { fontSize: 13, fontWeight: '500', marginBottom: 6 },
  taskTitle: { fontSize: 18, fontWeight: '600', lineHeight: 24 },
  text: { fontSize: 15, lineHeight: 22 },
  link: { color: '#7C3AED' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusButton: { alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6 },
  statusButtonText: { fontSize: 13, fontWeight: '600' },
  labels: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  labelChip: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  labelText: { fontSize: 13 },
  footer: { paddingHorizontal: 20, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  submit: { paddingVertical: 14, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  submitText: { fontSize: 15, fontWeight: '600' },
});
