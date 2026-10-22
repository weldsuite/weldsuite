/**
 * The task sheet: create a task, read its details, edit it, change its status
 * and delete it. One modal with three modes so the screens only manage the list.
 */

import React, { useEffect, useState } from 'react';
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

export function TaskSheet({ visible, initialMode, task, onClose, onCreated, onUpdated, onDeleted }: Readonly<TaskSheetProps>) {
  const { colors } = useTheme();
  const { t, intlLocale } = useI18n();
  const toast = useToast();
  const insets = useSafeAreaInsets();

  const [mode, setMode] = useState<TaskSheetMode>(initialMode);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<TaskStatus>('todo');
  const [dueDate, setDueDate] = useState('');
  const [errors, setErrors] = useState<FormErrors<'title' | 'dueDate'>>({});
  const [busy, setBusy] = useState(false);

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

  const isForm = mode === 'create' || mode === 'edit';
  const heading =
    mode === 'create' ? t.tasks.newTitle : mode === 'edit' ? t.tasks.editTitle : t.tasks.detailsTitle;

  const handleSubmit = async () => {
    const found = validateTask({ title, dueDate }, parseDateInput);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const parsed = parseDateInput(dueDate).date;
    setBusy(true);
    if (mode === 'create') {
      const res = await api.createCrmTask({
        title,
        description: optionalText(description),
        status,
        dueDate: parsed?.toISOString(),
      });
      setBusy(false);
      if (res.success && res.data) {
        toast.success(t.tasks.createdToast);
        onCreated(res.data);
      } else {
        toast.error(typeof res.error === 'string' ? res.error : t.tasks.createFailed);
      }
      return;
    }

    if (!task) return;
    const res = await api.updateCrmTask(task.id, {
      title,
      description: description.trim(),
      status,
      // Left out when empty: the API cannot clear a due date.
      dueDate: parsed?.toISOString(),
    });
    setBusy(false);
    if (res.success && res.data) {
      toast.success(t.tasks.updatedToast);
      onUpdated(res.data);
      setMode('view');
    } else {
      toast.error(typeof res.error === 'string' ? res.error : t.tasks.updateFailed);
    }
  };

  const handleStatusChange = async (next: TaskStatus) => {
    if (!task || next === task.status || busy) return;
    setBusy(true);
    const res = await api.updateCrmTask(task.id, { status: next });
    setBusy(false);
    if (res.success && res.data) {
      onUpdated(res.data);
      setStatus(next);
    } else {
      toast.error(typeof res.error === 'string' ? res.error : t.tasks.updateFailed);
    }
  };

  const handleDelete = () => {
    if (!task) return;
    Alert.alert(t.tasks.deleteTitle, interpolate(t.tasks.deleteMessage, { title: task.title }), [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.common.delete,
        style: 'destructive',
        onPress: () => {
          void (async () => {
            setBusy(true);
            const res = await api.deleteCrmTask(task.id);
            setBusy(false);
            if (res.success) {
              toast.success(t.tasks.deletedToast);
              onDeleted(task.id);
            } else {
              toast.error(typeof res.error === 'string' ? res.error : t.tasks.deleteFailed);
            }
          })();
        },
      },
    ]);
  };

  const dueDateValue = parseDate(task?.dueDate);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={[styles.sheet, { backgroundColor: colors.background, paddingTop: insets.top }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={[styles.header, { borderBottomColor: colors.divider }]}>
          <Text style={[styles.headerTitle, { color: colors.text }]} accessibilityRole="header">
            {heading}
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
                  onPress={handleDelete}
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

        {isForm ? (
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
                onChangeText={setTitle}
                placeholder={t.tasks.titlePlaceholder}
                error={errors.title ? describeError(t, errors.title, t.tasks.fieldTitle) : null}
                autoCapitalize="sentences"
              />
              <FormField
                label={t.tasks.fieldDescriptionOptional}
                value={description}
                onChangeText={setDescription}
                placeholder={t.tasks.descriptionPlaceholder}
                multiline
                numberOfLines={4}
              />
              <View style={styles.section}>
                <Text style={[styles.label, { color: colors.muted }]}>{t.tasks.fieldStatus}</Text>
                <StatusChips value={status} onSelect={setStatus} />
              </View>
              <DueDateField
                label={t.tasks.fieldDueDateOptional}
                value={dueDate}
                onChange={setDueDate}
                error={errors.dueDate ? describeError(t, errors.dueDate, t.tasks.fieldDueDate) : null}
                // The API cannot clear a due date, so an existing one can only be changed.
                allowClear={mode === 'create' || !task?.dueDate}
              />
            </ScrollView>
            <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12), borderTopColor: colors.divider }]}>
              <TouchableOpacity
                style={[styles.submit, { backgroundColor: colors.text, opacity: busy ? 0.6 : 1 }]}
                onPress={() => void handleSubmit()}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={mode === 'create' ? t.tasks.createTask : t.tasks.saveChanges}
              >
                {busy ? (
                  <ActivityIndicator color={colors.background} />
                ) : (
                  <Text style={[styles.submitText, { color: colors.background }]}>
                    {mode === 'create' ? t.tasks.createTask : t.tasks.saveChanges}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </>
        ) : task ? (
          <ScrollView
            style={styles.body}
            contentContainerStyle={[styles.bodyContent, { paddingBottom: insets.bottom + 24 }]}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.section}>
              <Text style={[styles.label, { color: colors.muted }]}>{t.tasks.fieldTitle}</Text>
              <Text style={[styles.taskTitle, { color: colors.text }]}>{task.title}</Text>
            </View>

            {!!task.description && (
              <View style={styles.section}>
                <Text style={[styles.label, { color: colors.muted }]}>{t.tasks.fieldDescription}</Text>
                <Text style={[styles.text, { color: colors.text }]}>{task.description}</Text>
              </View>
            )}

            <View style={styles.section}>
              <Text style={[styles.label, { color: colors.muted }]}>{t.tasks.fieldStatus}</Text>
              <StatusChips value={task.status} onSelect={(next) => void handleStatusChange(next)} disabled={busy} />
            </View>

            {!!task.linkedCompany && (
              <View style={styles.section}>
                <Text style={[styles.label, { color: colors.muted }]}>{t.tasks.fieldCompany}</Text>
                <Text style={[styles.text, { color: colors.text }]}>{task.linkedCompany.name}</Text>
              </View>
            )}

            {!!dueDateValue && (
              <View style={styles.section}>
                <Text style={[styles.label, { color: colors.muted }]}>{t.tasks.fieldDueDate}</Text>
                <View style={styles.row}>
                  <Calendar size={16} color={colors.text} strokeWidth={2} />
                  <Text style={[styles.text, { color: colors.text }]}>{formatDueLabel(dueDateValue, t, intlLocale)}</Text>
                </View>
              </View>
            )}

            {!!task.assignee && (
              <View style={styles.section}>
                <Text style={[styles.label, { color: colors.muted }]}>{t.tasks.fieldAssignee}</Text>
                <Text style={[styles.text, { color: colors.text }]}>{task.assignee.name}</Text>
              </View>
            )}

            <View style={styles.section}>
              <Text style={[styles.label, { color: colors.muted }]}>{t.tasks.fieldCreated}</Text>
              <Text style={[styles.text, { color: colors.text }]}>
                {new Date(task.createdAt).toLocaleDateString(intlLocale, {
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                })}
              </Text>
            </View>
          </ScrollView>
        ) : null}
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
