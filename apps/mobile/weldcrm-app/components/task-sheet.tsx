/**
 * The task sheet: create a task, read its details, edit it, change its status
 * and delete it. One modal with three modes so the screens only manage the list.
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Calendar, Edit3, Trash2, X } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { DueDateField } from '@/components/due-date-field';
import { FormField } from '@/components/form';
import { api, type CrmTask } from '@/services/api';
import { interpolate, useI18n } from '@/lib/i18n';
import { TASK_STATUSES, type TaskStatus } from '@/lib/crm';
import { formatDueLabel, parseDate, parseDateInput, toDateInput } from '@/lib/dates';
import { describeError, optionalText, validateTask, type FormErrors } from '@/lib/validation';

export const TASK_STATUS_COLORS: Record<TaskStatus, { color: string; bgColor: string }> = {
  todo: { color: '#6B7280', bgColor: '#F3F4F6' },
  'in-progress': { color: '#3B82F6', bgColor: '#DBEAFE' },
  blocked: { color: '#EF4444', bgColor: '#FEE2E2' },
  done: { color: '#10B981', bgColor: '#D1FAE5' },
};

export type TaskSheetMode = 'create' | 'view' | 'edit';

interface TaskSheetProps {
  visible: boolean;
  /** `create` opens an empty form; `view` shows `task`. */
  initialMode: TaskSheetMode;
  task: CrmTask | null;
  onClose: () => void;
  onCreated: (task: CrmTask) => void;
  onUpdated: (task: CrmTask) => void;
  onDeleted: (taskId: string) => void;
}

function StatusChips({
  value,
  onSelect,
  disabled,
}: Readonly<{ value: TaskStatus; onSelect: (status: TaskStatus) => void; disabled?: boolean }>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  return (
    <View style={styles.chips}>
      {TASK_STATUSES.map((status) => {
        const config = TASK_STATUS_COLORS[status];
        const selected = status === value;
        return (
          <TouchableOpacity
            key={status}
            style={[
              styles.chip,
              {
                backgroundColor: selected ? config.bgColor : colors.background,
                borderColor: selected ? config.color : colors.divider,
                opacity: disabled ? 0.6 : 1,
              },
            ]}
            onPress={() => onSelect(status)}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityState={{ selected }}
          >
            <Text style={[styles.chipText, { color: selected ? config.color : colors.text }]}>
              {t.tasks.status[status]}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

/** The API's error text when it sent one, else the screen's own message. */
function errorText(error: unknown, fallback: string): string {
  return typeof error === 'string' ? error : fallback;
}

interface TaskValues {
  title: string;
  description: string;
  status: TaskStatus;
  dueDate?: string;
}

interface TaskActionsOptions {
  task: CrmTask | null;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onCreated: (task: CrmTask) => void;
  onUpdated: (task: CrmTask) => void;
  onDeleted: (taskId: string) => void;
}

/** The sheet's calls to the API, each with its toast. */
function useTaskActions({ task, busy, setBusy, onCreated, onUpdated, onDeleted }: TaskActionsOptions) {
  const { t } = useI18n();
  const toast = useToast();

  const create = async (values: TaskValues) => {
    setBusy(true);
    const res = await api.createCrmTask({
      title: values.title,
      description: optionalText(values.description),
      status: values.status,
      dueDate: values.dueDate,
    });
    setBusy(false);
    if (res.success && res.data) {
      toast.success(t.tasks.createdToast);
      onCreated(res.data);
      return;
    }
    toast.error(errorText(res.error, t.tasks.createFailed));
  };

  /** Resolves true when the task was saved. */
  const update = async (values: TaskValues): Promise<boolean> => {
    if (!task) return false;
    setBusy(true);
    const res = await api.updateCrmTask(task.id, {
      title: values.title,
      description: values.description.trim(),
      status: values.status,
      // Left out when empty: the API cannot clear a due date.
      dueDate: values.dueDate,
    });
    setBusy(false);
    if (res.success && res.data) {
      toast.success(t.tasks.updatedToast);
      onUpdated(res.data);
      return true;
    }
    toast.error(errorText(res.error, t.tasks.updateFailed));
    return false;
  };

  /** Resolves true when the status was changed. */
  const changeStatus = async (next: TaskStatus): Promise<boolean> => {
    if (!task || next === task.status || busy) return false;
    setBusy(true);
    const res = await api.updateCrmTask(task.id, { status: next });
    setBusy(false);
    if (res.success && res.data) {
      onUpdated(res.data);
      return true;
    }
    toast.error(errorText(res.error, t.tasks.updateFailed));
    return false;
  };

  const remove = async (target: CrmTask) => {
    setBusy(true);
    const res = await api.deleteCrmTask(target.id);
    setBusy(false);
    if (res.success) {
      toast.success(t.tasks.deletedToast);
      onDeleted(target.id);
      return;
    }
    toast.error(errorText(res.error, t.tasks.deleteFailed));
  };

  const confirmDelete = () => {
    if (!task) return;
    Alert.alert(t.tasks.deleteTitle, interpolate(t.tasks.deleteMessage, { title: task.title }), [
      { text: t.common.cancel, style: 'cancel' },
      { text: t.common.delete, style: 'destructive', onPress: () => void remove(task) },
    ]);
  };

  return { create, update, changeStatus, confirmDelete };
}

interface TaskFormBodyProps {
  mode: TaskSheetMode;
  task: CrmTask | null;
  title: string;
  description: string;
  status: TaskStatus;
  dueDate: string;
  errors: FormErrors<'title' | 'dueDate'>;
  busy: boolean;
  onTitleChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onStatusChange: (status: TaskStatus) => void;
  onDueDateChange: (value: string) => void;
  onSubmit: () => void;
}

/** The create and edit form, with its submit button. */
function TaskFormBody({
  mode,
  task,
  title,
  description,
  status,
  dueDate,
  errors,
  busy,
  onTitleChange,
  onDescriptionChange,
  onStatusChange,
  onDueDateChange,
  onSubmit,
}: Readonly<TaskFormBodyProps>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
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
          value={title}
          onChangeText={onTitleChange}
          placeholder={t.tasks.titlePlaceholder}
          error={errors.title ? describeError(t, errors.title, t.tasks.fieldTitle) : null}
          autoCapitalize="sentences"
        />
        <FormField
          label={t.tasks.fieldDescriptionOptional}
          value={description}
          onChangeText={onDescriptionChange}
          placeholder={t.tasks.descriptionPlaceholder}
          multiline
          numberOfLines={4}
        />
        <View style={styles.section}>
          <Text style={[styles.label, { color: colors.muted }]}>{t.tasks.fieldStatus}</Text>
          <StatusChips value={status} onSelect={onStatusChange} />
        </View>
        <DueDateField
          label={t.tasks.fieldDueDateOptional}
          value={dueDate}
          onChange={onDueDateChange}
          error={errors.dueDate ? describeError(t, errors.dueDate, t.tasks.fieldDueDate) : null}
          // The API cannot clear a due date, so an existing one can only be changed.
          allowClear={mode === 'create' || !task?.dueDate}
        />
      </ScrollView>
      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12), borderTopColor: colors.divider }]}>
        <TouchableOpacity
          style={[styles.submit, { backgroundColor: colors.text, opacity: busy ? 0.6 : 1 }]}
          onPress={onSubmit}
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
}

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

interface TaskDetailsProps {
  task: CrmTask;
  busy: boolean;
  onStatusChange: (status: TaskStatus) => void;
}

/** The read-only view of a task. */
function TaskDetails({ task, busy, onStatusChange }: Readonly<TaskDetailsProps>) {
  const { colors } = useTheme();
  const { t, intlLocale } = useI18n();
  const insets = useSafeAreaInsets();
  const dueDateValue = parseDate(task.dueDate);

  return (
    <ScrollView
      style={styles.body}
      contentContainerStyle={[styles.bodyContent, { paddingBottom: insets.bottom + 24 }]}
      showsVerticalScrollIndicator={false}
    >
      <DetailSection label={t.tasks.fieldTitle}>
        <Text style={[styles.taskTitle, { color: colors.text }]}>{task.title}</Text>
      </DetailSection>

      {!!task.description && (
        <DetailSection label={t.tasks.fieldDescription}>
          <Text style={[styles.text, { color: colors.text }]}>{task.description}</Text>
        </DetailSection>
      )}

      <DetailSection label={t.tasks.fieldStatus}>
        <StatusChips value={task.status} onSelect={onStatusChange} disabled={busy} />
      </DetailSection>

      {!!task.linkedCompany && (
        <DetailSection label={t.tasks.fieldCompany}>
          <Text style={[styles.text, { color: colors.text }]}>{task.linkedCompany.name}</Text>
        </DetailSection>
      )}

      {!!dueDateValue && (
        <DetailSection label={t.tasks.fieldDueDate}>
          <View style={styles.row}>
            <Calendar size={16} color={colors.text} strokeWidth={2} />
            <Text style={[styles.text, { color: colors.text }]}>{formatDueLabel(dueDateValue, t, intlLocale)}</Text>
          </View>
        </DetailSection>
      )}

      {!!task.assignee && (
        <DetailSection label={t.tasks.fieldAssignee}>
          <Text style={[styles.text, { color: colors.text }]}>{task.assignee.name}</Text>
        </DetailSection>
      )}

      <DetailSection label={t.tasks.fieldCreated}>
        <Text style={[styles.text, { color: colors.text }]}>
          {new Date(task.createdAt).toLocaleDateString(intlLocale, {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          })}
        </Text>
      </DetailSection>
    </ScrollView>
  );
}

export function TaskSheet({ visible, initialMode, task, onClose, onCreated, onUpdated, onDeleted }: Readonly<TaskSheetProps>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();

  const [mode, setMode] = useState<TaskSheetMode>(initialMode);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<TaskStatus>('todo');
  const [dueDate, setDueDate] = useState('');
  const [errors, setErrors] = useState<FormErrors<'title' | 'dueDate'>>({});
  const [busy, setBusy] = useState(false);
  const actions = useTaskActions({ task, busy, setBusy, onCreated, onUpdated, onDeleted });

  // Each time the sheet opens, start in the requested mode with the task's values (or empty).
  useEffect(() => {
    if (!visible) return;
    setMode(initialMode);
    setTitle(task?.title ?? '');
    setDescription(task?.description ?? '');
    setStatus(task?.status ?? 'todo');
    setDueDate(toDateInput(parseDate(task?.dueDate)));
    setErrors({});
    setBusy(false);
  }, [visible, initialMode, task]);

  const headings: Record<TaskSheetMode, string> = {
    create: t.tasks.newTitle,
    edit: t.tasks.editTitle,
    view: t.tasks.detailsTitle,
  };

  const handleSubmit = async () => {
    const found = validateTask({ title, dueDate }, parseDateInput);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const values = { title, description, status, dueDate: parseDateInput(dueDate).date?.toISOString() };
    if (mode === 'create') {
      await actions.create(values);
      return;
    }
    if (await actions.update(values)) setMode('view');
  };

  const handleStatusChange = async (next: TaskStatus) => {
    if (await actions.changeStatus(next)) setStatus(next);
  };

  let body: ReactNode = null;
  if (mode === 'view') {
    if (task) body = <TaskDetails task={task} busy={busy} onStatusChange={(next) => void handleStatusChange(next)} />;
  } else {
    body = (
      <TaskFormBody
        mode={mode}
        task={task}
        title={title}
        description={description}
        status={status}
        dueDate={dueDate}
        errors={errors}
        busy={busy}
        onTitleChange={setTitle}
        onDescriptionChange={setDescription}
        onStatusChange={setStatus}
        onDueDateChange={setDueDate}
        onSubmit={() => void handleSubmit()}
      />
    );
  }

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
                  onPress={() => setMode('edit')}
                  style={styles.iconButton}
                  accessibilityRole="button"
                  accessibilityLabel={t.tasks.editTask}
                >
                  <Edit3 size={20} color={colors.text} />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={actions.confirmDelete}
                  style={styles.iconButton}
                  accessibilityRole="button"
                  accessibilityLabel={t.tasks.deleteTask}
                >
                  <Trash2 size={20} color={colors.destructive} />
                </TouchableOpacity>
              </>
            ) : null}
            <TouchableOpacity
              onPress={onClose}
              style={styles.iconButton}
              accessibilityRole="button"
              accessibilityLabel={t.common.close}
            >
              <X size={20} color={colors.text} strokeWidth={2} />
            </TouchableOpacity>
          </View>
        </View>

        {body}
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
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6, borderWidth: 1 },
  chipText: { fontSize: 13, fontWeight: '500' },
  footer: { paddingHorizontal: 20, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  submit: { paddingVertical: 14, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  submitText: { fontSize: 15, fontWeight: '600' },
});
