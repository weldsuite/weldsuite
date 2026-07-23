import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/ThemeContext';
import { useTask } from '@/contexts/TaskContext';
import { router } from 'expo-router';
import {
  X,
  Calendar,
  Flag,
  FolderKanban,
  Star,
  Tag,
  User,
} from 'lucide-react-native';
import type { TaskPriority } from '@/types/task.types';

const PRIORITY_OPTIONS: { label: string; value: TaskPriority; color: string }[] = [
  { label: 'Low', value: 'low', color: '#6B7280' },
  { label: 'Medium', value: 'medium', color: '#3B82F6' },
  { label: 'High', value: 'high', color: '#F59E0B' },
  { label: 'Urgent', value: 'urgent', color: '#EF4444' },
];

export default function CreateTaskScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { createTask, projects, loadProjects } = useTask();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [dueDate, setDueDate] = useState('');
  const [projectId, setProjectId] = useState<string | undefined>();
  const [isImportant, setIsImportant] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    loadProjects();
  }, []);

  const handleSubmit = async () => {
    if (!title.trim()) {
      Alert.alert('Error', 'Please enter a task title');
      return;
    }

    setIsSubmitting(true);
    try {
      const success = await createTask({
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        dueDate: dueDate || undefined,
        projectId,
        isImportant,
      });

      if (success) {
        router.back();
      } else {
        Alert.alert('Error', 'Failed to create task. Please try again.');
      }
    } catch (error) {
      Alert.alert('Error', 'An error occurred while creating the task.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const selectedProject = projects.find((p) => p.id === projectId);

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 10, borderBottomColor: colors.border }]}>
        <TouchableOpacity style={styles.closeButton} onPress={() => router.back()}>
          <X size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>New Task</Text>
        <TouchableOpacity
          style={[styles.saveButton, !title.trim() && styles.saveButtonDisabled]}
          onPress={handleSubmit}
          disabled={!title.trim() || isSubmitting}
        >
          <Text style={[styles.saveButtonText, !title.trim() && styles.saveButtonTextDisabled]}>
            {isSubmitting ? 'Saving...' : 'Save'}
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={[styles.contentContainer, { paddingBottom: insets.bottom + 20 }]}
        keyboardShouldPersistTaps="handled"
      >
        {/* Title Input */}
        <View style={styles.inputGroup}>
          <TextInput
            style={[styles.titleInput, { color: colors.text }]}
            placeholder="Task title"
            placeholderTextColor={colors.muted}
            value={title}
            onChangeText={setTitle}
            autoFocus
          />
        </View>

        {/* Description Input */}
        <View style={[styles.inputGroup, { borderColor: colors.border }]}>
          <TextInput
            style={[styles.descriptionInput, { color: colors.text }]}
            placeholder="Add description..."
            placeholderTextColor={colors.muted}
            value={description}
            onChangeText={setDescription}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
          />
        </View>

        {/* Priority */}
        <View style={[styles.optionRow, { borderColor: colors.border }]}>
          <View style={styles.optionLabel}>
            <Flag size={18} color={colors.muted} />
            <Text style={[styles.optionLabelText, { color: colors.text }]}>Priority</Text>
          </View>
          <View style={styles.priorityOptions}>
            {PRIORITY_OPTIONS.map((option) => (
              <TouchableOpacity
                key={option.value}
                style={[
                  styles.priorityChip,
                  priority === option.value
                    ? { backgroundColor: option.color }
                    : { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border },
                ]}
                onPress={() => setPriority(option.value)}
              >
                <Text
                  style={[
                    styles.priorityChipText,
                    { color: priority === option.value ? '#FFFFFF' : colors.text },
                  ]}
                >
                  {option.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Due Date */}
        <TouchableOpacity style={[styles.optionRow, { borderColor: colors.border }]}>
          <View style={styles.optionLabel}>
            <Calendar size={18} color={colors.muted} />
            <Text style={[styles.optionLabelText, { color: colors.text }]}>Due Date</Text>
          </View>
          <Text style={[styles.optionValue, { color: dueDate ? colors.text : colors.muted }]}>
            {dueDate || 'No due date'}
          </Text>
        </TouchableOpacity>

        {/* Project */}
        <TouchableOpacity style={[styles.optionRow, { borderColor: colors.border }]}>
          <View style={styles.optionLabel}>
            <FolderKanban size={18} color={colors.muted} />
            <Text style={[styles.optionLabelText, { color: colors.text }]}>Project</Text>
          </View>
          <Text style={[styles.optionValue, { color: selectedProject ? colors.text : colors.muted }]}>
            {selectedProject?.name || 'No project'}
          </Text>
        </TouchableOpacity>

        {/* Important */}
        <TouchableOpacity
          style={[styles.optionRow, { borderColor: colors.border }]}
          onPress={() => setIsImportant(!isImportant)}
        >
          <View style={styles.optionLabel}>
            <Star size={18} color={isImportant ? '#F59E0B' : colors.muted} fill={isImportant ? '#F59E0B' : 'transparent'} />
            <Text style={[styles.optionLabelText, { color: colors.text }]}>Important</Text>
          </View>
          <View style={[styles.toggle, isImportant && styles.toggleActive]}>
            <View style={[styles.toggleThumb, isImportant && styles.toggleThumbActive]} />
          </View>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  closeButton: {
    padding: 4,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  saveButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#8B5CF6',
    borderRadius: 8,
  },
  saveButtonDisabled: {
    backgroundColor: '#E5E7EB',
  },
  saveButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  saveButtonTextDisabled: {
    color: '#9CA3AF',
  },
  content: {
    flex: 1,
  },
  contentContainer: {
    padding: 16,
  },
  inputGroup: {
    marginBottom: 16,
  },
  titleInput: {
    fontSize: 22,
    fontWeight: '600',
    paddingVertical: 8,
  },
  descriptionInput: {
    fontSize: 16,
    minHeight: 100,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  optionLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  optionLabelText: {
    fontSize: 15,
  },
  optionValue: {
    fontSize: 15,
  },
  priorityOptions: {
    flexDirection: 'row',
    gap: 8,
  },
  priorityChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  priorityChipText: {
    fontSize: 13,
    fontWeight: '500',
  },
  toggle: {
    width: 48,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#E5E7EB',
    padding: 2,
    justifyContent: 'center',
  },
  toggleActive: {
    backgroundColor: '#8B5CF6',
  },
  toggleThumb: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
  },
  toggleThumbActive: {
    alignSelf: 'flex-end',
  },
});
