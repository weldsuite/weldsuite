import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  Modal,
  Pressable,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronLeft, Calendar, User, Flag, Check, Pencil } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useTask, useUpdateTaskStatus } from '@/hooks/use-weldflow';
import { StatusBadge } from '@/components/StatusBadge';
import { PriorityIndicator } from '@/components/PriorityIndicator';
import type { TaskStatus } from '@/types/weldflow';

const STATUS_OPTIONS: { value: TaskStatus; label: string }[] = [
  { value: 'backlog', label: 'Backlog' },
  { value: 'todo', label: 'To Do' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'in_review', label: 'In Review' },
  { value: 'testing', label: 'Testing' },
  { value: 'done', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' },
];

export default function TaskDetailScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { projectId, taskId } = useLocalSearchParams<{ projectId: string; taskId: string }>();
  const [pickerOpen, setPickerOpen] = useState(false);

  const { data, isLoading, refetch } = useTask(projectId, taskId);
  const task = data?.data;
  const updateStatus = useUpdateTaskStatus(projectId, taskId);

  const handleChangeStatus = async (status: TaskStatus) => {
    setPickerOpen(false);
    try {
      await updateStatus.mutateAsync({ status });
      await refetch();
    } catch (err) {
      console.error('[WeldFlow] Failed to change status:', err);
    }
  };

  if (isLoading) {
    return (
      <View style={[styles.loading, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color="#6366F1" />
      </View>
    );
  }

  if (!task) {
    return (
      <View style={[styles.loading, { backgroundColor: colors.background }]}>
        <Text style={{ color: colors.text }}>Task not found</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <ChevronLeft size={28} color={colors.text} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => router.push(`/task/edit/${projectId}/${taskId}`)}
          style={styles.backBtn}
        >
          <Pencil size={20} color={colors.text} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={[styles.title, { color: colors.text }]}>{task.title}</Text>

        <View style={styles.badgeRow}>
          <TouchableOpacity
            onPress={() => setPickerOpen(true)}
            disabled={updateStatus.isPending}
            activeOpacity={0.7}
          >
            <StatusBadge status={task.status} />
          </TouchableOpacity>
          <PriorityIndicator priority={task.priority} showLabel />
        </View>

        {task.description ? (
          <View style={[styles.section, { backgroundColor: colors.cardBackground, borderColor: colors.divider }]}>
            <Text style={[styles.sectionLabel, { color: colors.muted }]}>Description</Text>
            <Text style={[styles.bodyText, { color: colors.text }]}>{task.description}</Text>
          </View>
        ) : null}

        <View style={[styles.section, { backgroundColor: colors.cardBackground, borderColor: colors.divider }]}>
          <Text style={[styles.sectionLabel, { color: colors.muted }]}>Details</Text>

          {task.assigneeId ? (
            <View style={[styles.detailRow, { borderBottomColor: colors.divider }]}>
              <View style={styles.detailLeft}>
                <User size={16} color={colors.muted} />
                <Text style={[styles.detailLabel, { color: colors.text }]}>Assignee</Text>
              </View>
              <Text style={[styles.detailValue, { color: colors.muted }]} numberOfLines={1}>
                {task.assigneeId}
              </Text>
            </View>
          ) : null}

          {task.dueDate ? (
            <View style={[styles.detailRow, { borderBottomColor: colors.divider }]}>
              <View style={styles.detailLeft}>
                <Calendar size={16} color={colors.muted} />
                <Text style={[styles.detailLabel, { color: colors.text }]}>Due Date</Text>
              </View>
              <Text style={[styles.detailValue, { color: colors.muted }]}>
                {new Date(task.dueDate).toLocaleDateString()}
              </Text>
            </View>
          ) : null}

          <View style={[styles.detailRow, { borderBottomColor: colors.divider }]}>
            <View style={styles.detailLeft}>
              <Flag size={16} color={colors.muted} />
              <Text style={[styles.detailLabel, { color: colors.text }]}>Priority</Text>
            </View>
            <Text style={[styles.detailValue, { color: colors.muted, textTransform: 'capitalize' }]}>
              {task.priority}
            </Text>
          </View>

          {task.estimatedHours ? (
            <View style={styles.detailRow}>
              <Text style={[styles.detailLabel, { color: colors.text, marginLeft: 24 }]}>Estimate</Text>
              <Text style={[styles.detailValue, { color: colors.muted }]}>{task.estimatedHours} h</Text>
            </View>
          ) : null}
        </View>

        {task.tags && task.tags.length > 0 ? (
          <View style={[styles.section, { backgroundColor: colors.cardBackground, borderColor: colors.divider }]}>
            <Text style={[styles.sectionLabel, { color: colors.muted }]}>Tags</Text>
            <View style={styles.tagRow}>
              {task.tags.map((tag) => (
                <View key={tag} style={[styles.tag, { borderColor: colors.divider }]}>
                  <Text style={[styles.tagText, { color: colors.text }]}>{tag}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}
      </ScrollView>

      <Modal visible={pickerOpen} transparent animationType="fade" onRequestClose={() => setPickerOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setPickerOpen(false)}>
          <Pressable
            style={[styles.modalSheet, { backgroundColor: colors.cardBackground, paddingBottom: insets.bottom + 16 }]}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={[styles.modalTitle, { color: colors.text }]}>Change status</Text>
            {STATUS_OPTIONS.map((opt) => {
              const active = opt.value === task.status;
              return (
                <TouchableOpacity
                  key={opt.value}
                  style={[styles.modalOption, { borderBottomColor: colors.divider }]}
                  onPress={() => handleChangeStatus(opt.value)}
                >
                  <Text style={[styles.modalOptionText, { color: colors.text }]}>{opt.label}</Text>
                  {active ? <Check size={18} color="#6366F1" /> : null}
                </TouchableOpacity>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  backBtn: { padding: 8 },
  scroll: { padding: 16, gap: 16 },
  title: { fontSize: 24, fontWeight: '700', lineHeight: 30 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  section: { borderRadius: 12, borderWidth: 0.5, padding: 14, gap: 8 },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  bodyText: { fontSize: 15, lineHeight: 22 },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 0.5,
  },
  detailLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  detailLabel: { fontSize: 14, fontWeight: '500' },
  detailValue: { fontSize: 14, flexShrink: 1, textAlign: 'right' },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, borderWidth: 0.5 },
  tagText: { fontSize: 12, fontWeight: '500' },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  modalSheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
  },
  modalTitle: { fontSize: 18, fontWeight: '700', marginBottom: 12 },
  modalOption: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: 0.5,
  },
  modalOptionText: { fontSize: 16 },
});
