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
  type LucideIcon,
} from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import {
  type TaskStatus,
  type TaskPriority,
  type CreateTaskInput,
  type UpdateTaskInput,
  type ProjectLabel,
  type ProjectMember,
  LABEL_COLORS,
} from '@/types/weldflow';
import { useProjectMembers, useLabels, useCreateLabel } from '@/hooks/use-weldflow';
import { labelsForIds, resolveLabelIds } from '@/lib/task-labels';
import { TaskStatusBadge } from './status-badge';
import { PriorityIndicator } from './PriorityIndicator';
import { BRAND } from '@/lib/brand';

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
type DateKind = 'startDate' | 'dueDate';
type ThemeColors = ReturnType<typeof useTheme>['colors'];

const ACCENT = '#E84C3D';

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

function toggleInList(list: string[], item: string): string[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

function memberDisplayName(member: ProjectMember): string {
  return member.user?.name || member.user?.email || member.userId;
}

function describeAssignees(assigneeIds: string[], members: ProjectMember[]): string {
  if (assigneeIds.length === 0) return 'Unassigned';
  if (assigneeIds.length > 1) return `${assigneeIds.length} assignees`;
  const member = members.find((x) => x.userId === assigneeIds[0]);
  return member ? memberDisplayName(member) : assigneeIds[0];
}

/** Returns the normalised hours string, or null when the input is not numeric. */
function parseCustomHours(trimmed: string): string | null {
  if (!trimmed) return '';
  return Number.isNaN(Number(trimmed)) ? null : trimmed;
}

function checkNewLabelName(name: string, labels: ProjectLabel[]): 'empty' | 'duplicate' | null {
  if (!name) return 'empty';
  return labels.some((l) => l.name.toLowerCase() === name.toLowerCase()) ? 'duplicate' : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error';
}

// ---------------------------------------------------------------------------
// Presentational building blocks
// ---------------------------------------------------------------------------

function FieldShell({ label, half, colors, children }: Readonly<{ label: string; half?: boolean; colors: ThemeColors; children: React.ReactNode }>) {
  return (
    <View style={half ? [styles.field, styles.rowCol] : styles.field}>
      <Text style={[styles.label, { color: colors.muted }]}>{label}</Text>
      {children}
    </View>
  );
}

function PickerButton({
  onPress,
  colors,
  extraStyle,
  children,
}: Readonly<{ onPress: () => void; colors: ThemeColors; extraStyle?: object; children: React.ReactNode }>) {
  return (
    <TouchableOpacity
      style={[styles.pickerButton, extraStyle, { backgroundColor: colors.cardBackground, borderColor: colors.divider }]}
      onPress={onPress}
    >
      {children}
    </TouchableOpacity>
  );
}

interface PickerFieldProps {
  label: string;
  icon: LucideIcon;
  text: string;
  hasValue: boolean;
  half?: boolean;
  colors: ThemeColors;
  onOpen: () => void;
  onClear?: () => void;
}

function PickerField({ label, icon: Icon, text, hasValue, half, colors, onOpen, onClear }: Readonly<PickerFieldProps>) {
  return (
    <FieldShell label={label} half={half} colors={colors}>
      <PickerButton onPress={onOpen} colors={colors}>
        <View style={styles.iconLeft}>
          <Icon size={16} color={colors.muted} />
          <Text style={[styles.pickerText, { color: hasValue ? colors.text : colors.muted }]}>{text}</Text>
        </View>
        {hasValue && onClear ? (
          <TouchableOpacity onPress={onClear} hitSlop={8}>
            <X size={16} color={colors.muted} />
          </TouchableOpacity>
        ) : (
          <ChevronDown size={18} color={colors.muted} />
        )}
      </PickerButton>
    </FieldShell>
  );
}

interface SheetModalProps {
  visible: boolean;
  onClose: () => void;
  colors: ThemeColors;
  bottomInset: number;
  maxHeight?: `${number}%`;
  animationType?: 'fade' | 'slide';
  children: React.ReactNode;
}

function SheetModal({ visible, onClose, colors, bottomInset, maxHeight, animationType = 'fade', children }: Readonly<SheetModalProps>) {
  return (
    <Modal visible={visible} transparent animationType={animationType} onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable
          style={[
            styles.modalSheet,
            { backgroundColor: colors.cardBackground, paddingBottom: bottomInset + 16 },
            maxHeight ? { maxHeight } : undefined,
          ]}
          onPress={(e) => e.stopPropagation()}
        >
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function SheetHeader({ title, actionLabel, colors, onClose }: Readonly<{ title: string; actionLabel: string; colors: ThemeColors; onClose: () => void }>) {
  return (
    <View style={styles.sheetHeader}>
      <Text style={[styles.modalTitle, { color: colors.text, marginBottom: 0 }]}>{title}</Text>
      <TouchableOpacity onPress={onClose}>
        <Text style={[styles.sheetAction, { color: ACCENT }]}>{actionLabel}</Text>
      </TouchableOpacity>
    </View>
  );
}

function OptionRow({ onPress, selected, colors, children }: Readonly<{ onPress: () => void; selected?: boolean; colors: ThemeColors; children: React.ReactNode }>) {
  return (
    <TouchableOpacity style={[styles.modalOption, { borderBottomColor: colors.divider }]} onPress={onPress}>
      {children}
      {selected ? <Check size={18} color={BRAND} /> : null}
    </TouchableOpacity>
  );
}

function OptionText({ colors, children, accent }: Readonly<{ colors: ThemeColors; children: React.ReactNode; accent?: boolean }>) {
  return (
    <Text style={[styles.modalOptionText, accent ? { color: ACCENT, fontWeight: '600' } : { color: colors.text }]}>
      {children}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

interface OptionSheetProps {
  picker: PickerType;
  status: TaskStatus;
  priority: TaskPriority;
  colors: ThemeColors;
  bottomInset: number;
  onSelectStatus: (status: TaskStatus) => void;
  onSelectPriority: (priority: TaskPriority) => void;
  onClose: () => void;
}

function StatusPrioritySheet({ picker, status, priority, colors, bottomInset, onSelectStatus, onSelectPriority, onClose }: Readonly<OptionSheetProps>) {
  const isStatus = picker === 'status';
  const options = isStatus ? STATUS_OPTIONS : PRIORITY_OPTIONS;
  const isActive = (value: string) => (isStatus ? value === status : value === priority);
  const handleSelect = (value: string) => {
    if (isStatus) onSelectStatus(value as TaskStatus);
    else onSelectPriority(value as TaskPriority);
    onClose();
  };

  return (
    <SheetModal
      visible={picker === 'status' || picker === 'priority'}
      onClose={onClose}
      colors={colors}
      bottomInset={bottomInset}
    >
      <Text style={[styles.modalTitle, { color: colors.text }]}>
        {isStatus ? 'Change status' : 'Change priority'}
      </Text>
      {options.map((opt) => (
        <OptionRow key={opt.value} colors={colors} selected={isActive(opt.value)} onPress={() => handleSelect(opt.value)}>
          <Text style={[styles.modalOptionText, { color: colors.text }]}>{opt.label}</Text>
        </OptionRow>
      ))}
    </SheetModal>
  );
}

function MemberRow({ member, selected, colors, onToggle }: Readonly<{ member: ProjectMember; selected: boolean; colors: ThemeColors; onToggle: () => void }>) {
  const showEmail = !!member.user?.email && !!member.user?.name;
  return (
    <OptionRow colors={colors} selected={selected} onPress={onToggle}>
      <View style={styles.memberInfo}>
        <Text style={[styles.modalOptionText, { color: colors.text }]} numberOfLines={1}>
          {memberDisplayName(member)}
        </Text>
        {showEmail ? (
          <Text style={[styles.memberEmail, { color: colors.muted }]} numberOfLines={1}>
            {member.user?.email}
          </Text>
        ) : null}
      </View>
    </OptionRow>
  );
}

interface AssigneesSheetProps {
  visible: boolean;
  isLoading: boolean;
  members: ProjectMember[];
  assigneeIds: string[];
  colors: ThemeColors;
  bottomInset: number;
  onToggle: (userId: string) => void;
  onClose: () => void;
}

function AssigneesSheet({ visible, isLoading, members, assigneeIds, colors, bottomInset, onToggle, onClose }: Readonly<AssigneesSheetProps>) {
  let body: React.ReactNode;
  if (isLoading) {
    body = <ActivityIndicator style={{ marginTop: 16 }} color={BRAND} />;
  } else if (members.length === 0) {
    body = <Text style={[styles.emptyState, { color: colors.muted }]}>No members on this project yet.</Text>;
  } else {
    body = (
      <ScrollView>
        {members.map((m) => (
          <MemberRow
            key={m.id}
            member={m}
            colors={colors}
            selected={assigneeIds.includes(m.userId)}
            onToggle={() => onToggle(m.userId)}
          />
        ))}
      </ScrollView>
    );
  }

  return (
    <SheetModal visible={visible} onClose={onClose} colors={colors} bottomInset={bottomInset} maxHeight="70%">
      <SheetHeader title="Assignees" actionLabel="Done" colors={colors} onClose={onClose} />
      {body}
    </SheetModal>
  );
}

interface HoursSheetProps {
  visible: boolean;
  estimatedHours: string;
  customMode: boolean;
  customInput: string;
  colors: ThemeColors;
  bottomInset: number;
  onCustomInputChange: (value: string) => void;
  onConfirmCustom: () => void;
  onPickPreset: (value: string) => void;
  onSelectCustom: () => void;
  onClose: () => void;
}

function HoursSheet({
  visible,
  estimatedHours,
  customMode,
  customInput,
  colors,
  bottomInset,
  onCustomInputChange,
  onConfirmCustom,
  onPickPreset,
  onSelectCustom,
  onClose,
}: Readonly<HoursSheetProps>) {
  return (
    <SheetModal visible={visible} onClose={onClose} colors={colors} bottomInset={bottomInset}>
      <SheetHeader title="Estimated hours" actionLabel="Close" colors={colors} onClose={onClose} />

      {customMode ? (
        <View style={styles.customInputWrap}>
          <TextInput
            style={[
              styles.input,
              { color: colors.text, backgroundColor: colors.background, borderColor: colors.divider, flex: 1 },
            ]}
            placeholder="Enter hours e.g. 2.5"
            placeholderTextColor={colors.muted}
            value={customInput}
            onChangeText={onCustomInputChange}
            keyboardType="decimal-pad"
            autoFocus
            onSubmitEditing={onConfirmCustom}
          />
          <TouchableOpacity style={styles.customConfirmBtn} onPress={onConfirmCustom}>
            <Text style={styles.customConfirmText}>Save</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView>
          {HOUR_PRESETS.map((p) => (
            <OptionRow key={p.value} colors={colors} selected={estimatedHours === p.value} onPress={() => onPickPreset(p.value)}>
              <OptionText colors={colors}>{p.label}</OptionText>
            </OptionRow>
          ))}
          <OptionRow colors={colors} onPress={onSelectCustom}>
            <OptionText colors={colors} accent>Custom…</OptionText>
          </OptionRow>
        </ScrollView>
      )}
    </SheetModal>
  );
}

interface NewLabelFormProps {
  name: string;
  color: string;
  isPending: boolean;
  colors: ThemeColors;
  onNameChange: (name: string) => void;
  onColorChange: (color: string) => void;
  onCancel: () => void;
  onCreate: () => void;
}

function NewLabelForm({ name, color, isPending, colors, onNameChange, onColorChange, onCancel, onCreate }: Readonly<NewLabelFormProps>) {
  const createDisabled = isPending || !name.trim();

  return (
    <View style={styles.newLabelWrap}>
      <TextInput
        style={[
          styles.input,
          { color: colors.text, backgroundColor: colors.background, borderColor: colors.divider },
        ]}
        placeholder="Label name"
        placeholderTextColor={colors.muted}
        value={name}
        onChangeText={onNameChange}
        autoFocus
      />
      <View style={styles.colorRow}>
        {LABEL_COLORS.map((c) => (
          <TouchableOpacity
            key={c}
            onPress={() => onColorChange(c)}
            style={[
              styles.colorSwatch,
              { backgroundColor: c, borderColor: c === color ? colors.text : 'transparent' },
            ]}
          />
        ))}
      </View>
      <View style={styles.newLabelActions}>
        <TouchableOpacity
          onPress={onCancel}
          style={[styles.secondaryBtn, { borderColor: colors.divider }]}
        >
          <Text style={[styles.secondaryBtnText, { color: colors.text }]}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onCreate}
          disabled={createDisabled}
          style={[styles.primaryBtn, createDisabled && { opacity: 0.6 }]}
        >
          {isPending ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.primaryBtnText}>Create</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

interface LabelsSheetProps {
  visible: boolean;
  isLoading: boolean;
  availableLabels: ProjectLabel[];
  selectedLabelIds: string[];
  colors: ThemeColors;
  bottomInset: number;
  onToggle: (labelId: string) => void;
  onCreated: (labelId: string) => void;
  onClose: () => void;
}

function LabelsSheet({ visible, isLoading, availableLabels, selectedLabelIds, colors, bottomInset, onToggle, onCreated, onClose }: Readonly<LabelsSheetProps>) {
  const createLabel = useCreateLabel();

  // Create-on-the-fly UI
  const [creatingLabel, setCreatingLabel] = useState(false);
  const [newLabelName, setNewLabelName] = useState('');
  const [newLabelColor, setNewLabelColor] = useState<string>(LABEL_COLORS[4]); // #3b82f6 blue

  const handleCreateLabel = async () => {
    const name = newLabelName.trim();
    const problem = checkNewLabelName(name, availableLabels);
    if (problem === 'empty') return;
    if (problem === 'duplicate') {
      Alert.alert('Label exists', 'A label with that name already exists.');
      return;
    }
    try {
      const res = await createLabel.mutateAsync({ name, color: newLabelColor });
      onCreated(res.data.id);
      setNewLabelName('');
      setCreatingLabel(false);
    } catch (err) {
      Alert.alert('Could not create label', errorMessage(err));
    }
  };

  const handleCancelCreate = () => {
    setCreatingLabel(false);
    setNewLabelName('');
  };

  const showEmptyHint = availableLabels.length === 0 && !creatingLabel;

  return (
    <SheetModal visible={visible} onClose={onClose} colors={colors} bottomInset={bottomInset} maxHeight="75%">
      <SheetHeader title="Labels" actionLabel="Done" colors={colors} onClose={onClose} />

      {isLoading ? (
        <ActivityIndicator style={{ marginTop: 16 }} color={BRAND} />
      ) : (
        <ScrollView>
          {availableLabels.map((l) => (
            <OptionRow key={l.id} colors={colors} selected={selectedLabelIds.includes(l.id)} onPress={() => onToggle(l.id)}>
              <View style={styles.labelRowLeft}>
                <View style={[styles.labelDot, { backgroundColor: l.color }]} />
                <Text style={[styles.modalOptionText, { color: colors.text }]}>{l.name}</Text>
              </View>
            </OptionRow>
          ))}

          {showEmptyHint ? (
            <Text style={[styles.emptyState, { color: colors.muted }]}>
              No labels yet. Create your first below.
            </Text>
          ) : null}

          {creatingLabel ? (
            <NewLabelForm
              name={newLabelName}
              color={newLabelColor}
              isPending={createLabel.isPending}
              colors={colors}
              onNameChange={setNewLabelName}
              onColorChange={setNewLabelColor}
              onCancel={handleCancelCreate}
              onCreate={handleCreateLabel}
            />
          ) : (
            <OptionRow colors={colors} onPress={() => setCreatingLabel(true)}>
              <View style={styles.labelRowLeft}>
                <Plus size={18} color={BRAND} />
                <OptionText colors={colors} accent>Create new label</OptionText>
              </View>
            </OptionRow>
          )}
        </ScrollView>
      )}
    </SheetModal>
  );
}

interface DatePickerModalProps {
  picker: PickerType;
  startDate: string | null;
  dueDate: string | null;
  colors: ThemeColors;
  bottomInset: number;
  onChange: (kind: DateKind, iso: string) => void;
  onClear: (kind: DateKind) => void;
  onClose: () => void;
}

function DatePickerModal({ picker, startDate, dueDate, colors, bottomInset, onChange, onClear, onClose }: Readonly<DatePickerModalProps>) {
  if (picker !== 'startDate' && picker !== 'dueDate') return null;

  const current = picker === 'startDate' ? startDate : dueDate;
  const value = current ? new Date(current) : new Date();
  const handleValueChange = (_event: unknown, selected: Date) => {
    if (Platform.OS === 'android') onClose();
    onChange(picker, selected.toISOString());
  };
  const handleDismiss = () => {
    if (Platform.OS === 'android') onClose();
  };

  if (Platform.OS !== 'ios') {
    return (
      <DateTimePicker
        value={value}
        mode="date"
        display="default"
        onValueChange={handleValueChange}
        onDismiss={handleDismiss}
      />
    );
  }

  return (
    <SheetModal visible onClose={onClose} colors={colors} bottomInset={bottomInset} animationType="slide">
      <View style={styles.sheetHeader}>
        <TouchableOpacity onPress={() => onClear(picker)}>
          <Text style={[styles.sheetAction, { color: '#DC2626' }]}>Clear</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onClose}>
          <Text style={[styles.sheetAction, { color: ACCENT }]}>Done</Text>
        </TouchableOpacity>
      </View>
      <DateTimePicker
        value={value}
        mode="date"
        display="spinner"
        onValueChange={handleValueChange}
        themeVariant={colors.text === '#FFFFFF' ? 'dark' : 'light'}
      />
    </SheetModal>
  );
}

function TitleField({ value, error, autoFocus, colors, onChange }: Readonly<{ value: string; error: string | null; autoFocus: boolean; colors: ThemeColors; onChange: (value: string) => void }>) {
  return (
    <FieldShell label="Title" colors={colors}>
      <TextInput
        style={[
          styles.input,
          {
            color: colors.text,
            backgroundColor: colors.cardBackground,
            borderColor: error ? '#DC2626' : colors.divider,
          },
        ]}
        placeholder="Task title"
        placeholderTextColor={colors.muted}
        value={value}
        onChangeText={onChange}
        returnKeyType="next"
        autoFocus={autoFocus}
      />
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </FieldShell>
  );
}

function SubmitButton({ isSubmitting, label, onPress }: Readonly<{ isSubmitting: boolean; label: string; onPress: () => void }>) {
  return (
    <TouchableOpacity
      style={[styles.submitBtn, isSubmitting && { opacity: 0.7 }]}
      onPress={onPress}
      disabled={isSubmitting}
    >
      {isSubmitting ? (
        <ActivityIndicator size="small" color="#fff" />
      ) : (
        <Text style={styles.submitText}>{label}</Text>
      )}
    </TouchableOpacity>
  );
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

export function TaskForm({
  mode,
  projectId,
  initialValues,
  onSubmit,
  submitLabel,
  isSubmitting = false,
}: Readonly<Props>) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const membersQuery = useProjectMembers(projectId);
  const members = membersQuery.data?.data ?? [];

  const labelsQuery = useLabels();
  const availableLabels = useMemo(() => labelsQuery.data?.data ?? [], [labelsQuery.data]);

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

  // tasks.labels holds label IDs. Entries an older build saved by name are
  // resolved to their ID here, so the next save writes IDs only.
  const selectedLabelIds = useMemo(
    () => resolveLabelIds(selectedLabels, availableLabels),
    [selectedLabels, availableLabels],
  );
  const selectedLabelObjects = useMemo<ProjectLabel[]>(
    () => labelsForIds(selectedLabelIds, availableLabels),
    [availableLabels, selectedLabelIds],
  );

  const closePicker = () => setPicker(null);

  const toggleAssignee = (userId: string) => setAssigneeIds((current) => toggleInList(current, userId));

  const toggleLabel = (labelId: string) =>
    setSelectedLabels((current) => toggleInList(resolveLabelIds(current, availableLabels), labelId));

  const setDateFor = (kind: DateKind, iso: string | null) => {
    if (kind === 'startDate') setStartDate(iso);
    else setDueDate(iso);
  };

  const clearDate = (kind: DateKind) => {
    setDateFor(kind, null);
    setPicker(null);
  };

  const handleTitleChange = (value: string) => {
    setTitle(value);
    setTitleError(null);
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
    const parsed = parseCustomHours(hoursCustomInput.trim());
    if (parsed === null) {
      Alert.alert('Invalid value', 'Enter a numeric hour value, e.g. 2.5');
      return;
    }
    setEstimatedHours(parsed);
    setPicker(null);
  };

  const clearHours = () => {
    setEstimatedHours('');
    setHoursCustomMode(false);
    setHoursCustomInput('');
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
      labels: selectedLabelIds,
      assigneeIds,
    });
  };

  return (
    <View style={styles.container}>
      <TitleField
        value={title}
        error={titleError}
        autoFocus={mode === 'create'}
        colors={colors}
        onChange={handleTitleChange}
      />

      <FieldShell label="Description" colors={colors}>
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
      </FieldShell>

      <View style={styles.row}>
        <FieldShell label="Status" half colors={colors}>
          <PickerButton onPress={() => setPicker('status')} colors={colors}>
            <TaskStatusBadge status={status} />
            <ChevronDown size={18} color={colors.muted} />
          </PickerButton>
        </FieldShell>

        <FieldShell label="Priority" half colors={colors}>
          <PickerButton onPress={() => setPicker('priority')} colors={colors}>
            <PriorityIndicator priority={priority} showLabel />
            <ChevronDown size={18} color={colors.muted} />
          </PickerButton>
        </FieldShell>
      </View>

      <View style={styles.row}>
        <PickerField
          label="Start date"
          icon={CalIcon}
          text={formatDate(startDate)}
          hasValue={!!startDate}
          half
          colors={colors}
          onOpen={() => setPicker('startDate')}
          onClear={() => setStartDate(null)}
        />
        <PickerField
          label="Due date"
          icon={CalIcon}
          text={formatDate(dueDate)}
          hasValue={!!dueDate}
          half
          colors={colors}
          onOpen={() => setPicker('dueDate')}
          onClear={() => setDueDate(null)}
        />
      </View>

      <PickerField
        label="Assignees"
        icon={Users}
        text={describeAssignees(assigneeIds, members)}
        hasValue={assigneeIds.length > 0}
        colors={colors}
        onOpen={() => setPicker('assignees')}
      />

      <PickerField
        label="Estimated hours"
        icon={Clock}
        text={formatHours(estimatedHours)}
        hasValue={!!estimatedHours}
        colors={colors}
        onOpen={() => setPicker('hours')}
        onClear={clearHours}
      />

      <FieldShell label="Labels" colors={colors}>
        <PickerButton onPress={() => setPicker('labels')} colors={colors} extraStyle={styles.labelPickerButton}>
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
        </PickerButton>
      </FieldShell>

      <SubmitButton
        isSubmitting={isSubmitting}
        label={submitLabel ?? (mode === 'create' ? 'Create task' : 'Save changes')}
        onPress={handleSubmit}
      />

      <StatusPrioritySheet
        picker={picker}
        status={status}
        priority={priority}
        colors={colors}
        bottomInset={insets.bottom}
        onSelectStatus={setStatus}
        onSelectPriority={setPriority}
        onClose={closePicker}
      />

      <AssigneesSheet
        visible={picker === 'assignees'}
        isLoading={membersQuery.isLoading}
        members={members}
        assigneeIds={assigneeIds}
        colors={colors}
        bottomInset={insets.bottom}
        onToggle={toggleAssignee}
        onClose={closePicker}
      />

      <HoursSheet
        visible={picker === 'hours'}
        estimatedHours={estimatedHours}
        customMode={hoursCustomMode}
        customInput={hoursCustomInput}
        colors={colors}
        bottomInset={insets.bottom}
        onCustomInputChange={setHoursCustomInput}
        onConfirmCustom={handleConfirmCustomHours}
        onPickPreset={handlePickPresetHours}
        onSelectCustom={handleSelectCustomHours}
        onClose={closePicker}
      />

      <LabelsSheet
        visible={picker === 'labels'}
        isLoading={labelsQuery.isLoading}
        availableLabels={availableLabels}
        selectedLabelIds={selectedLabelIds}
        colors={colors}
        bottomInset={insets.bottom}
        onToggle={toggleLabel}
        onCreated={(labelId) => setSelectedLabels((current) => [...current, labelId])}
        onClose={closePicker}
      />

      <DatePickerModal
        picker={picker}
        startDate={startDate}
        dueDate={dueDate}
        colors={colors}
        bottomInset={insets.bottom}
        onChange={setDateFor}
        onClear={clearDate}
        onClose={closePicker}
      />
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
    backgroundColor: BRAND,
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
    backgroundColor: BRAND,
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
    backgroundColor: BRAND,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
  },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
