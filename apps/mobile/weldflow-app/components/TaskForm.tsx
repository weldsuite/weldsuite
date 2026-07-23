import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Modal,
  Pressable,
  ActivityIndicator,
  Platform,
  ScrollView,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DateTimePicker from '@react-native-community/datetimepicker';
import {
  Check,
  ChevronDown,
  X,
  Calendar as CalIcon,
  Users,
  Clock,
  Tag as TagIcon,
  Plus,
} from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import type {
  TaskStatus,
  TaskPriority,
  CreateTaskInput,
  UpdateTaskInput,
  ProjectLabel,
} from '@/types/weldflow';
import { LABEL_COLORS } from '@/types/weldflow';
import { useProjectMembers, useLabels, useCreateLabel } from '@/hooks/use-weldflow';
import { StatusBadge } from './StatusBadge';
import { PriorityIndicator } from './PriorityIndicator';

export interface TaskFormValues {
  title: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  startDate: string | null;
  dueDate: string | null;
  estimatedHours: string;
  labels: string[];
  assigneeIds: string[];
}

interface Props {
  mode: 'create' | 'edit';
  projectId: string;
  initialValues?: Partial<TaskFormValues>;
  onSubmit: (values: TaskFormValues) => Promise<void> | void;
  submitLabel?: string;
  isSubmitting?: boolean;
}

const STATUS_OPTIONS: { value: TaskStatus; label: string }[] = [
  { value: 'backlog', label: 'Backlog' },
  { value: 'todo', label: 'To Do' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'in_review', label: 'In Review' },
  { value: 'testing', label: 'Testing' },
  { value: 'done', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' },
];

const PRIORITY_OPTIONS: { value: TaskPriority; label: string }[] = [
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
  { value: 'none', label: 'None' },
];

// Hour presets mirror the platform Duration popover (15/30/45/60/90/120 min)
// plus a few longer values common for engineering estimates.
const HOUR_PRESETS: { value: string; label: string }[] = [
  { value: '0.25', label: '15 minutes' },
  { value: '0.5', label: '30 minutes' },
  { value: '0.75', label: '45 minutes' },
  { value: '1', label: '1 hour' },
  { value: '1.5', label: '1.5 hours' },
  { value: '2', label: '2 hours' },
  { value: '4', label: '4 hours' },
  { value: '8', label: '8 hours' },
];

type PickerType = null | 'status' | 'priority' | 'dueDate' | 'startDate' | 'assignees' | 'hours' | 'labels';

function formatDate(iso: string | null): string {
  if (!iso) return 'Not set';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Invalid date';
  return d.toLocaleDateString();
}

function formatHours(raw: string): string {
  if (!raw) return 'Not set';
  const preset = HOUR_PRESETS.find((p) => p.value === raw);
  if (preset) return preset.label;
  const n = Number(raw);
  if (Number.isNaN(n)) return raw;
  return n === 1 ? '1 hour' : `${n} hours`;
}

export function TaskForm({
  mode,
  projectId,
  initialValues,
  onSubmit,
  submitLabel,
  isSubmitting = false,
}: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const membersQuery = useProjectMembers(projectId);
  const members = membersQuery.data?.data ?? [];

  const labelsQuery = useLabels();
  const availableLabels = labelsQuery.data?.data ?? [];
  const createLabel = useCreateLabel();

  const [title, setTitle] = useState(initialValues?.title ?? '');
  const [description, setDescription] = useState(initialValues?.description ?? '');
  const [priority, setPriority] = useState<TaskPriority>(initialValues?.priority ?? 'medium');
  const [status, setStatus] = useState<TaskStatus>(initialValues?.status ?? 'todo');
  const [startDate, setStartDate] = useState<string | null>(initialValues?.startDate ?? null);
  const [dueDate, setDueDate] = useState<string | null>(initialValues?.dueDate ?? null);
  const [estimatedHours, setEstimatedHours] = useState(initialValues?.estimatedHours ?? '');
  const [selectedLabels, setSelectedLabels] = useState<string[]>(initialValues?.labels ?? []);
  const [assigneeIds, setAssigneeIds] = useState<string[]>(initialValues?.assigneeIds ?? []);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [picker, setPicker] = useState<PickerType>(null);

  // Hours picker — tracks whether the user chose "Custom..." to show an inline input
  const [hoursCustomMode, setHoursCustomMode] = useState(
    !!initialValues?.estimatedHours &&
      !HOUR_PRESETS.some((p) => p.value === initialValues.estimatedHours),
  );
  const [hoursCustomInput, setHoursCustomInput] = useState(
    hoursCustomMode ? (initialValues?.estimatedHours ?? '') : '',
  );

  // Labels picker — create-on-the-fly UI
  const [creatingLabel, setCreatingLabel] = useState(false);
  const [newLabelName, setNewLabelName] = useState('');
  const [newLabelColor, setNewLabelColor] = useState<string>(LABEL_COLORS[4]); // #3b82f6 blue

  const selectedLabelObjects = useMemo<ProjectLabel[]>(
    () => availableLabels.filter((l) => selectedLabels.includes(l.name)),
    [availableLabels, selectedLabels],
  );

  const toggleAssignee = (userId: string) => {
    setAssigneeIds((current) =>
      current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId],
    );
  };

  const toggleLabel = (name: string) => {
    setSelectedLabels((current) =>
      current.includes(name) ? current.filter((n) => n !== name) : [...current, name],
    );
  };

  const assigneeLabel = () => {
    if (assigneeIds.length === 0) return 'Unassigned';
    if (assigneeIds.length === 1) {
      const m = members.find((x) => x.userId === assigneeIds[0]);
      return m?.user?.name || m?.user?.email || assigneeIds[0];
    }
    return `${assigneeIds.length} assignees`;
  };

  const handleDateChange = (kind: 'startDate' | 'dueDate') => (
    _event: unknown,
    selected?: Date,
  ) => {
    if (Platform.OS === 'android') setPicker(null);
    if (!selected) return;
    const iso = selected.toISOString();
    if (kind === 'startDate') setStartDate(iso);
    else setDueDate(iso);
  };

  const clearDate = (kind: 'startDate' | 'dueDate') => {
    if (kind === 'startDate') setStartDate(null);
    else setDueDate(null);
    setPicker(null);
  };

  const handlePickPresetHours = (value: string) => {
    setEstimatedHours(value);
    setHoursCustomMode(false);
    setHoursCustomInput('');
    setPicker(null);
  };

  const handleSelectCustomHours = () => {
    setHoursCustomMode(true);
    setHoursCustomInput(estimatedHours);
  };

  const handleConfirmCustomHours = () => {
    const trimmed = hoursCustomInput.trim();
    if (!trimmed) {
      setEstimatedHours('');
    } else if (Number.isNaN(Number(trimmed))) {
      Alert.alert('Invalid value', 'Enter a numeric hour value, e.g. 2.5');
      return;
    } else {
      setEstimatedHours(trimmed);
    }
    setPicker(null);
  };

  const clearHours = () => {
    setEstimatedHours('');
    setHoursCustomMode(false);
    setHoursCustomInput('');
  };

  const handleCreateLabel = async () => {
    const name = newLabelName.trim();
    if (!name) return;
    if (availableLabels.some((l) => l.name.toLowerCase() === name.toLowerCase())) {
      Alert.alert('Label exists', 'A label with that name already exists.');
      return;
    }
    try {
      const res = await createLabel.mutateAsync({ name, color: newLabelColor });
      setSelectedLabels((current) => [...current, res.data.name]);
      setNewLabelName('');
      setCreatingLabel(false);
    } catch (err) {
      Alert.alert('Could not create label', err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const handleSubmit = async () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setTitleError('Title is required');
      return;
    }
    setTitleError(null);
    await onSubmit({
      title: trimmed,
      description: description.trim(),
      priority,
      status,
      startDate,
      dueDate,
      estimatedHours: estimatedHours.trim(),
      labels: selectedLabels,
      assigneeIds,
    });
  };

  return (
    <View style={styles.container}>
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.muted }]}>Title</Text>
        <TextInput
          style={[
            styles.input,
            {
              color: colors.text,
              backgroundColor: colors.cardBackground,
              borderColor: titleError ? '#DC2626' : colors.divider,
            },
          ]}
          placeholder="Task title"
          placeholderTextColor={colors.muted}
          value={title}
          onChangeText={(v) => {
            setTitle(v);
            if (titleError) setTitleError(null);
          }}
          returnKeyType="next"
          autoFocus={mode === 'create'}
        />
        {titleError ? <Text style={styles.errorText}>{titleError}</Text> : null}
      </View>

      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.muted }]}>Description</Text>
        <TextInput
          style={[
            styles.input,
            styles.multiline,
            { color: colors.text, backgroundColor: colors.cardBackground, borderColor: colors.divider },
          ]}
          placeholder="Add more detail (optional)"
          placeholderTextColor={colors.muted}
          value={description}
          onChangeText={setDescription}
          multiline
          textAlignVertical="top"
        />
      </View>

      <View style={styles.row}>
        <View style={[styles.field, styles.rowCol]}>
          <Text style={[styles.label, { color: colors.muted }]}>Status</Text>
          <TouchableOpacity
            style={[styles.pickerButton, { backgroundColor: colors.cardBackground, borderColor: colors.divider }]}
            onPress={() => setPicker('status')}
          >
            <StatusBadge status={status} />
            <ChevronDown size={18} color={colors.muted} />
          </TouchableOpacity>
        </View>

        <View style={[styles.field, styles.rowCol]}>
          <Text style={[styles.label, { color: colors.muted }]}>Priority</Text>
          <TouchableOpacity
            style={[styles.pickerButton, { backgroundColor: colors.cardBackground, borderColor: colors.divider }]}
            onPress={() => setPicker('priority')}
          >
            <PriorityIndicator priority={priority} showLabel />
            <ChevronDown size={18} color={colors.muted} />
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.row}>
        <View style={[styles.field, styles.rowCol]}>
          <Text style={[styles.label, { color: colors.muted }]}>Start date</Text>
          <TouchableOpacity
            style={[styles.pickerButton, { backgroundColor: colors.cardBackground, borderColor: colors.divider }]}
            onPress={() => setPicker('startDate')}
          >
            <View style={styles.iconLeft}>
              <CalIcon size={16} color={colors.muted} />
              <Text style={[styles.pickerText, { color: startDate ? colors.text : colors.muted }]}>
                {formatDate(startDate)}
              </Text>
            </View>
            {startDate ? (
              <TouchableOpacity onPress={() => setStartDate(null)} hitSlop={8}>
                <X size={16} color={colors.muted} />
              </TouchableOpacity>
            ) : (
              <ChevronDown size={18} color={colors.muted} />
            )}
          </TouchableOpacity>
        </View>

        <View style={[styles.field, styles.rowCol]}>
          <Text style={[styles.label, { color: colors.muted }]}>Due date</Text>
          <TouchableOpacity
            style={[styles.pickerButton, { backgroundColor: colors.cardBackground, borderColor: colors.divider }]}
            onPress={() => setPicker('dueDate')}
          >
            <View style={styles.iconLeft}>
              <CalIcon size={16} color={colors.muted} />
              <Text style={[styles.pickerText, { color: dueDate ? colors.text : colors.muted }]}>
                {formatDate(dueDate)}
              </Text>
            </View>
            {dueDate ? (
              <TouchableOpacity onPress={() => setDueDate(null)} hitSlop={8}>
                <X size={16} color={colors.muted} />
              </TouchableOpacity>
            ) : (
              <ChevronDown size={18} color={colors.muted} />
            )}
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.muted }]}>Assignees</Text>
        <TouchableOpacity
          style={[styles.pickerButton, { backgroundColor: colors.cardBackground, borderColor: colors.divider }]}
          onPress={() => setPicker('assignees')}
        >
          <View style={styles.iconLeft}>
            <Users size={16} color={colors.muted} />
            <Text style={[styles.pickerText, { color: assigneeIds.length > 0 ? colors.text : colors.muted }]}>
              {assigneeLabel()}
            </Text>
          </View>
          <ChevronDown size={18} color={colors.muted} />
        </TouchableOpacity>
      </View>

      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.muted }]}>Estimated hours</Text>
        <TouchableOpacity
          style={[styles.pickerButton, { backgroundColor: colors.cardBackground, borderColor: colors.divider }]}
          onPress={() => setPicker('hours')}
        >
          <View style={styles.iconLeft}>
            <Clock size={16} color={colors.muted} />
            <Text style={[styles.pickerText, { color: estimatedHours ? colors.text : colors.muted }]}>
              {formatHours(estimatedHours)}
            </Text>
          </View>
          {estimatedHours ? (
            <TouchableOpacity onPress={clearHours} hitSlop={8}>
              <X size={16} color={colors.muted} />
            </TouchableOpacity>
          ) : (
            <ChevronDown size={18} color={colors.muted} />
          )}
        </TouchableOpacity>
      </View>

      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.muted }]}>Labels</Text>
        <TouchableOpacity
          style={[styles.pickerButton, styles.labelPickerButton, { backgroundColor: colors.cardBackground, borderColor: colors.divider }]}
          onPress={() => setPicker('labels')}
        >
          <View style={styles.labelPickerInner}>
            <TagIcon size={16} color={colors.muted} />
            {selectedLabelObjects.length === 0 ? (
              <Text style={[styles.pickerText, { color: colors.muted }]}>None</Text>
            ) : (
              <View style={styles.labelChipRow}>
                {selectedLabelObjects.map((l) => (
                  <View key={l.id} style={[styles.labelChip, { backgroundColor: l.color }]}>
                    <Text style={styles.labelChipText}>{l.name}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>
          <ChevronDown size={18} color={colors.muted} />
        </TouchableOpacity>
      </View>

      <TouchableOpacity
        style={[styles.submitBtn, isSubmitting && { opacity: 0.7 }]}
        onPress={handleSubmit}
        disabled={isSubmitting}
      >
        {isSubmitting ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <Text style={styles.submitText}>
            {submitLabel ?? (mode === 'create' ? 'Create task' : 'Save changes')}
          </Text>
        )}
      </TouchableOpacity>

      {/* Status / Priority bottom sheet */}
      <Modal
        visible={picker === 'status' || picker === 'priority'}
        transparent
        animationType="fade"
        onRequestClose={() => setPicker(null)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setPicker(null)}>
          <Pressable
            style={[styles.modalSheet, { backgroundColor: colors.cardBackground, paddingBottom: insets.bottom + 16 }]}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={[styles.modalTitle, { color: colors.text }]}>
              {picker === 'status' ? 'Change status' : 'Change priority'}
            </Text>
            {(picker === 'status' ? STATUS_OPTIONS : PRIORITY_OPTIONS).map((opt) => {
              const active = picker === 'status' ? opt.value === status : opt.value === priority;
              return (
                <TouchableOpacity
                  key={opt.value}
                  style={[styles.modalOption, { borderBottomColor: colors.divider }]}
                  onPress={() => {
                    if (picker === 'status') setStatus(opt.value as TaskStatus);
                    else setPriority(opt.value as TaskPriority);
                    setPicker(null);
                  }}
                >
                  <Text style={[styles.modalOptionText, { color: colors.text }]}>{opt.label}</Text>
                  {active ? <Check size={18} color="#6366F1" /> : null}
                </TouchableOpacity>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Assignees bottom sheet — multi-select */}
      <Modal
        visible={picker === 'assignees'}
        transparent
        animationType="fade"
        onRequestClose={() => setPicker(null)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setPicker(null)}>
          <Pressable
            style={[
              styles.modalSheet,
              { backgroundColor: colors.cardBackground, paddingBottom: insets.bottom + 16, maxHeight: '70%' },
            ]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={styles.sheetHeader}>
              <Text style={[styles.modalTitle, { color: colors.text, marginBottom: 0 }]}>Assignees</Text>
              <TouchableOpacity onPress={() => setPicker(null)}>
                <Text style={[styles.sheetAction, { color: '#6366F1' }]}>Done</Text>
              </TouchableOpacity>
            </View>
            {membersQuery.isLoading ? (
              <ActivityIndicator style={{ marginTop: 16 }} color="#6366F1" />
            ) : members.length === 0 ? (
              <Text style={[styles.emptyState, { color: colors.muted }]}>No members on this project yet.</Text>
            ) : (
              <ScrollView>
                {members.map((m) => {
                  const selected = assigneeIds.includes(m.userId);
                  const display = m.user?.name || m.user?.email || m.userId;
                  return (
                    <TouchableOpacity
                      key={m.id}
                      style={[styles.modalOption, { borderBottomColor: colors.divider }]}
                      onPress={() => toggleAssignee(m.userId)}
                    >
                      <View style={styles.memberInfo}>
                        <Text style={[styles.modalOptionText, { color: colors.text }]} numberOfLines={1}>
                          {display}
                        </Text>
                        {m.user?.email && m.user?.name ? (
                          <Text style={[styles.memberEmail, { color: colors.muted }]} numberOfLines={1}>
                            {m.user.email}
                          </Text>
                        ) : null}
                      </View>
                      {selected ? <Check size={18} color="#6366F1" /> : null}
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Hours bottom sheet — preset + custom */}
      <Modal
        visible={picker === 'hours'}
        transparent
        animationType="fade"
        onRequestClose={() => setPicker(null)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setPicker(null)}>
          <Pressable
            style={[styles.modalSheet, { backgroundColor: colors.cardBackground, paddingBottom: insets.bottom + 16 }]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={styles.sheetHeader}>
              <Text style={[styles.modalTitle, { color: colors.text, marginBottom: 0 }]}>Estimated hours</Text>
              <TouchableOpacity onPress={() => setPicker(null)}>
                <Text style={[styles.sheetAction, { color: '#6366F1' }]}>Close</Text>
              </TouchableOpacity>
            </View>

            {hoursCustomMode ? (
              <View style={styles.customInputWrap}>
                <TextInput
                  style={[
                    styles.input,
                    { color: colors.text, backgroundColor: colors.background, borderColor: colors.divider, flex: 1 },
                  ]}
                  placeholder="Enter hours e.g. 2.5"
                  placeholderTextColor={colors.muted}
                  value={hoursCustomInput}
                  onChangeText={setHoursCustomInput}
                  keyboardType="decimal-pad"
                  autoFocus
                  onSubmitEditing={handleConfirmCustomHours}
                />
                <TouchableOpacity style={styles.customConfirmBtn} onPress={handleConfirmCustomHours}>
                  <Text style={styles.customConfirmText}>Save</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <ScrollView>
                {HOUR_PRESETS.map((p) => {
                  const active = estimatedHours === p.value;
                  return (
                    <TouchableOpacity
                      key={p.value}
                      style={[styles.modalOption, { borderBottomColor: colors.divider }]}
                      onPress={() => handlePickPresetHours(p.value)}
                    >
                      <Text style={[styles.modalOptionText, { color: colors.text }]}>{p.label}</Text>
                      {active ? <Check size={18} color="#6366F1" /> : null}
                    </TouchableOpacity>
                  );
                })}
                <TouchableOpacity
                  style={[styles.modalOption, { borderBottomColor: colors.divider }]}
                  onPress={handleSelectCustomHours}
                >
                  <Text style={[styles.modalOptionText, { color: '#6366F1', fontWeight: '600' }]}>Custom…</Text>
                </TouchableOpacity>
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Labels bottom sheet — multi-select w/ create */}
      <Modal
        visible={picker === 'labels'}
        transparent
        animationType="fade"
        onRequestClose={() => setPicker(null)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setPicker(null)}>
          <Pressable
            style={[
              styles.modalSheet,
              { backgroundColor: colors.cardBackground, paddingBottom: insets.bottom + 16, maxHeight: '75%' },
            ]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={styles.sheetHeader}>
              <Text style={[styles.modalTitle, { color: colors.text, marginBottom: 0 }]}>Labels</Text>
              <TouchableOpacity onPress={() => setPicker(null)}>
                <Text style={[styles.sheetAction, { color: '#6366F1' }]}>Done</Text>
              </TouchableOpacity>
            </View>

            {labelsQuery.isLoading ? (
              <ActivityIndicator style={{ marginTop: 16 }} color="#6366F1" />
            ) : (
              <ScrollView>
                {availableLabels.map((l) => {
                  const selected = selectedLabels.includes(l.name);
                  return (
                    <TouchableOpacity
                      key={l.id}
                      style={[styles.modalOption, { borderBottomColor: colors.divider }]}
                      onPress={() => toggleLabel(l.name)}
                    >
                      <View style={styles.labelRowLeft}>
                        <View style={[styles.labelDot, { backgroundColor: l.color }]} />
                        <Text style={[styles.modalOptionText, { color: colors.text }]}>{l.name}</Text>
                      </View>
                      {selected ? <Check size={18} color="#6366F1" /> : null}
                    </TouchableOpacity>
                  );
                })}

                {availableLabels.length === 0 && !creatingLabel ? (
                  <Text style={[styles.emptyState, { color: colors.muted }]}>
                    No labels yet. Create your first below.
                  </Text>
                ) : null}

                {creatingLabel ? (
                  <View style={styles.newLabelWrap}>
                    <TextInput
                      style={[
                        styles.input,
                        { color: colors.text, backgroundColor: colors.background, borderColor: colors.divider },
                      ]}
                      placeholder="Label name"
                      placeholderTextColor={colors.muted}
                      value={newLabelName}
                      onChangeText={setNewLabelName}
                      autoFocus
                    />
                    <View style={styles.colorRow}>
                      {LABEL_COLORS.map((c) => (
                        <TouchableOpacity
                          key={c}
                          onPress={() => setNewLabelColor(c)}
                          style={[
                            styles.colorSwatch,
                            { backgroundColor: c, borderColor: c === newLabelColor ? colors.text : 'transparent' },
                          ]}
                        />
                      ))}
                    </View>
                    <View style={styles.newLabelActions}>
                      <TouchableOpacity
                        onPress={() => {
                          setCreatingLabel(false);
                          setNewLabelName('');
                        }}
                        style={[styles.secondaryBtn, { borderColor: colors.divider }]}
                      >
                        <Text style={[styles.secondaryBtnText, { color: colors.text }]}>Cancel</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={handleCreateLabel}
                        disabled={createLabel.isPending || !newLabelName.trim()}
                        style={[styles.primaryBtn, (createLabel.isPending || !newLabelName.trim()) && { opacity: 0.6 }]}
                      >
                        {createLabel.isPending ? (
                          <ActivityIndicator size="small" color="#fff" />
                        ) : (
                          <Text style={styles.primaryBtnText}>Create</Text>
                        )}
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : (
                  <TouchableOpacity
                    style={[styles.modalOption, { borderBottomColor: colors.divider }]}
                    onPress={() => setCreatingLabel(true)}
                  >
                    <View style={styles.labelRowLeft}>
                      <Plus size={18} color="#6366F1" />
                      <Text style={[styles.modalOptionText, { color: '#6366F1', fontWeight: '600' }]}>
                        Create new label
                      </Text>
                    </View>
                  </TouchableOpacity>
                )}
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Date picker */}
      {picker === 'startDate' || picker === 'dueDate' ? (
        Platform.OS === 'ios' ? (
          <Modal visible transparent animationType="slide" onRequestClose={() => setPicker(null)}>
            <Pressable style={styles.modalBackdrop} onPress={() => setPicker(null)}>
              <Pressable
                style={[styles.modalSheet, { backgroundColor: colors.cardBackground, paddingBottom: insets.bottom + 16 }]}
                onPress={(e) => e.stopPropagation()}
              >
                <View style={styles.sheetHeader}>
                  <TouchableOpacity onPress={() => clearDate(picker)}>
                    <Text style={[styles.sheetAction, { color: '#DC2626' }]}>Clear</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setPicker(null)}>
                    <Text style={[styles.sheetAction, { color: '#6366F1' }]}>Done</Text>
                  </TouchableOpacity>
                </View>
                <DateTimePicker
                  value={
                    (picker === 'startDate' ? startDate : dueDate)
                      ? new Date((picker === 'startDate' ? startDate : dueDate) as string)
                      : new Date()
                  }
                  mode="date"
                  display="spinner"
                  onChange={handleDateChange(picker)}
                  themeVariant={colors.text === '#FFFFFF' ? 'dark' : 'light'}
                />
              </Pressable>
            </Pressable>
          </Modal>
        ) : (
          <DateTimePicker
            value={
              (picker === 'startDate' ? startDate : dueDate)
                ? new Date((picker === 'startDate' ? startDate : dueDate) as string)
                : new Date()
            }
            mode="date"
            display="default"
            onChange={handleDateChange(picker)}
          />
        )
      ) : null}
    </View>
  );
}

export function toCreateTaskInput(values: TaskFormValues): CreateTaskInput {
  return {
    title: values.title,
    description: values.description || undefined,
    priority: values.priority,
    status: values.status,
    type: 'task',
    isBillable: true,
    startDate: values.startDate ?? undefined,
    dueDate: values.dueDate ?? undefined,
    estimatedHours: values.estimatedHours || undefined,
    labels: values.labels.length > 0 ? values.labels : undefined,
    assigneeId: values.assigneeIds[0] ?? undefined,
    assigneeIds: values.assigneeIds.length > 0 ? values.assigneeIds : undefined,
  };
}

export function toUpdateTaskInput(values: TaskFormValues): UpdateTaskInput {
  return {
    title: values.title,
    description: values.description || undefined,
    priority: values.priority,
    status: values.status,
    startDate: values.startDate ?? undefined,
    dueDate: values.dueDate ?? undefined,
    estimatedHours: values.estimatedHours || undefined,
    labels: values.labels,
    assigneeId: values.assigneeIds[0] ?? undefined,
    assigneeIds: values.assigneeIds,
  };
}

const styles = StyleSheet.create({
  container: { gap: 16 },
  field: { gap: 6 },
  row: { flexDirection: 'row', gap: 12 },
  rowCol: { flex: 1 },
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
  multiline: { minHeight: 100, paddingTop: 12 },
  errorText: { fontSize: 12, color: '#DC2626' },
  pickerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 0.5,
    minHeight: 46,
  },
  iconLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  pickerText: { fontSize: 14 },
  labelPickerButton: { minHeight: 50 },
  labelPickerInner: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  labelChipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, flex: 1 },
  labelChip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  labelChipText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  submitBtn: {
    backgroundColor: '#6366F1',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  modalSheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16 },
  modalTitle: { fontSize: 18, fontWeight: '700', marginBottom: 12 },
  modalOption: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: 0.5,
  },
  modalOptionText: { fontSize: 16 },
  sheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 8,
  },
  sheetAction: { fontSize: 16, fontWeight: '600' },
  memberInfo: { flex: 1, gap: 2, marginRight: 12 },
  memberEmail: { fontSize: 13 },
  emptyState: { fontSize: 14, textAlign: 'center', paddingVertical: 24 },
  customInputWrap: { flexDirection: 'row', gap: 8, paddingVertical: 8 },
  customConfirmBtn: {
    backgroundColor: '#6366F1',
    borderRadius: 10,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  customConfirmText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  labelRowLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  labelDot: { width: 14, height: 14, borderRadius: 7 },
  newLabelWrap: { paddingVertical: 12, gap: 12 },
  colorRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  colorSwatch: { width: 28, height: 28, borderRadius: 14, borderWidth: 2 },
  newLabelActions: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end' },
  secondaryBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 0.5,
  },
  secondaryBtnText: { fontSize: 15, fontWeight: '500' },
  primaryBtn: {
    backgroundColor: '#6366F1',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
  },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
