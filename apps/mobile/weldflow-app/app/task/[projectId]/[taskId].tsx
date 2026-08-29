/**
 * Task detail — status change + field summary from `GET /api/tasks/:id`.
 */

import { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Modal,
  Pressable,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useObserve } from 'expo-observe';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Check, Pencil } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';

import { BRAND } from '@/lib/brand';
import { formatDate } from '@/lib/date';
import { Screen, ScreenHeader } from '@/components/screen';
import { SectionCard, DetailRow } from '@/components/detail';
import { DetailSkeleton, ErrorState } from '@/components/data-states';
import { TaskStatusBadge } from '@/components/status-badge';
import { PriorityIndicator } from '@/components/PriorityIndicator';
import { useTask, useUpdateTaskStatus } from '@/hooks/use-weldflow';
import { statusLabel, useI18n } from '@/lib/i18n';
import { hideAppSplash } from '@/utils/splash';
import type { TaskStatus } from '@/types/weldflow';

const STATUS_OPTIONS: TaskStatus[] = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'testing',
  'done',
  'cancelled',
];

export default function TaskDetailScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { markInteractive } = useObserve();
  const { projectId, taskId } = useLocalSearchParams<{ projectId: string; taskId: string }>();
  const { t, format } = useI18n();
  const [pickerOpen, setPickerOpen] = useState(false);

  const { data, isLoading, refetch, isError } = useTask(projectId, taskId);
  const task = data?.data;
  const updateStatus = useUpdateTaskStatus(projectId, taskId);

  useEffect(() => {
    if (!isLoading) {
      hideAppSplash();
      markInteractive();
    }
  }, [isLoading, markInteractive]);

  const handleChangeStatus = async (status: TaskStatus) => {
    setPickerOpen(false);
    try {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await updateStatus.mutateAsync({ status });
      await refetch();
    } catch (err) {
      console.error('[WeldFlow] Failed to change status:', err);
    }
  };

  if (isLoading) {
    return (
      <Screen header={<ScreenHeader title={t.task.editTitle} showBack />}>
        <DetailSkeleton />
      </Screen>
    );
  }

  if (!task || isError) {
    return (
      <Screen header={<ScreenHeader title={t.appName} showBack />}>
        <ErrorState message={t.task.notFound} onRetry={() => void refetch()} />
      </Screen>
    );
  }

  return (
    <Screen
      header={
        <ScreenHeader
          title={task.title}
          showBack
          actions={
            <IconButton
              icon={<Pencil size={20} color={colors.text} />}
              accessibilityLabel={t.task.edit}
              onPress={() => router.push(`/task/edit/${projectId}/${taskId}`)}
            />
          }
        />
      }
    >
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.badgeRow}>
          <Pressable
            onPress={() => setPickerOpen(true)}
            disabled={updateStatus.isPending}
            accessibilityRole="button"
            accessibilityLabel={t.task.changeStatus}
            style={({ pressed }) => pressed && { opacity: 0.7 }}
          >
            <TaskStatusBadge status={task.status} />
          </Pressable>
          <PriorityIndicator priority={task.priority} showLabel />
        </View>

        {task.description ? (
          <SectionCard title={t.task.description}>
            <Text style={[styles.bodyText, { color: colors.text }]}>{task.description}</Text>
          </SectionCard>
        ) : null}

        <SectionCard title={t.task.details}>
          {task.assigneeId ? (
            <DetailRow label={t.task.assignee} value={task.assigneeId} />
          ) : null}
          {task.dueDate ? (
            <DetailRow label={t.task.dueDate} value={formatDate(task.dueDate)} />
          ) : null}
          <DetailRow
            label={t.task.priority}
            value={
              (t.priority as Record<string, string>)[task.priority] ?? task.priority
            }
          />
          {task.estimatedHours ? (
            <DetailRow
              label={t.task.estimate}
              value={format(t.task.estimateHours, { hours: task.estimatedHours })}
            />
          ) : null}
        </SectionCard>

        {task.tags && task.tags.length > 0 ? (
          <SectionCard title={t.task.tags}>
            <View style={styles.tagRow}>
              {task.tags.map((tag) => (
                <View key={tag} style={[styles.tag, { backgroundColor: colors.secondary }]}>
                  <Text style={[styles.tagText, { color: colors.text }]}>{tag}</Text>
                </View>
              ))}
            </View>
          </SectionCard>
        ) : null}
      </ScrollView>

      <Modal visible={pickerOpen} transparent animationType="fade" onRequestClose={() => setPickerOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setPickerOpen(false)}>
          <Pressable
            style={[
              styles.modalSheet,
              { backgroundColor: colors.cardBackground, paddingBottom: insets.bottom + 16 },
            ]}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={[styles.modalTitle, { color: colors.text }]}>{t.task.changeStatus}</Text>
            {STATUS_OPTIONS.map((value) => {
              const active = value === task.status;
              return (
                <Pressable
                  key={value}
                  style={({ pressed }) => [
                    styles.modalOption,
                    { borderBottomColor: colors.border },
                    pressed && { backgroundColor: colors.pressed },
                  ]}
                  onPress={() => void handleChangeStatus(value)}
                >
                  <Text style={[styles.modalOptionText, { color: colors.text }]}>
                    {statusLabel(t, value)}
                  </Text>
                  {active ? <Check size={18} color={BRAND} /> : null}
                </Pressable>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingBottom: 24 },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
  },
  bodyText: { fontSize: 15, lineHeight: 22 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  tagText: { fontSize: 12, fontWeight: '500' },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  modalSheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 16,
  },
  modalTitle: { fontSize: 18, fontWeight: '700', marginBottom: 12 },
  modalOption: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modalOptionText: { fontSize: 16 },
});
