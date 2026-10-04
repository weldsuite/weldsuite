/**
 * Task detail — status change + field summary from `GET /api/tasks/:id`.
 */

import { useEffect, useState, type ReactNode } from 'react';
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
import { Check, CheckSquare, Pencil } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';
import { Spinner } from '@weldsuite/mobile-ui/components/Spinner';

import { ACCENTS, BRAND } from '@/lib/brand';
import { formatDate, formatShortDate, isTaskOverdue } from '@/lib/date';
import { Screen, ScreenHeader } from '@/components/screen';
import { SectionCard, DetailRow, IconTile } from '@/components/detail';
import { RecordRow } from '@/components/record-row';
import { DetailSkeleton, ErrorState } from '@/components/data-states';
import { TaskStatusBadge } from '@/components/status-badge';
import { PriorityIndicator } from '@/components/PriorityIndicator';
import { useProjectMembers, useSubtasks, useTask, useUpdateTaskStatus } from '@/hooks/use-weldflow';
import { formatTaskAssigneeDisplay } from '@/lib/assignee-display';
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
  const membersQuery = useProjectMembers(projectId);
  const subtaskTotal = task?.subtaskCount ?? 0;
  const subtasksQuery = useSubtasks(taskId, subtaskTotal > 0);
  const subtasks = subtasksQuery.data?.data ?? [];
  const updateStatus = useUpdateTaskStatus(projectId, taskId);
  const assigneeDisplay = task
    ? formatTaskAssigneeDisplay(task, membersQuery.data?.data)
    : null;

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

  let subtasksBody: ReactNode;
  if (subtasksQuery.isLoading) {
    subtasksBody = (
      <View style={styles.subtasksLoading}>
        <Spinner />
      </View>
    );
  } else if (subtasksQuery.isError) {
    subtasksBody = (
      <Pressable
        onPress={() => void subtasksQuery.refetch()}
        accessibilityRole="button"
        accessibilityLabel={t.common.tryAgain}
      >
        <Text style={[styles.subtasksError, { color: colors.mutedForeground }]}>
          {t.common.somethingWentWrong} {t.common.tryAgain}
        </Text>
      </Pressable>
    );
  } else {
    subtasksBody = subtasks.map((child) => {
      const overdue = isTaskOverdue(child.dueDate, child.status);
      return (
        <RecordRow
          key={child.id}
          leading={<IconTile icon={CheckSquare} color={ACCENTS.tasks} />}
          title={child.title}
          subtitle={
            child.subtaskCount
              ? format(t.task.subtaskProgress, {
                  done: child.completedSubtaskCount ?? 0,
                  total: child.subtaskCount,
                })
              : undefined
          }
          meta={
            child.dueDate
              ? format(t.common.dueOn, { date: formatShortDate(child.dueDate) })
              : undefined
          }
          metaColor={overdue ? colors.destructive : undefined}
          badge={<TaskStatusBadge status={child.status} />}
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            router.push(`/task/${projectId}/${child.id}`);
          }}
        />
      );
    });
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
          {assigneeDisplay ? (
            <DetailRow label={t.task.assignee} value={assigneeDisplay} />
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

        {subtaskTotal > 0 ? (
          <SectionCard title={t.task.subtasks} padded={false}>
            {subtasksBody}
          </SectionCard>
        ) : null}

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
  subtasksLoading: { paddingVertical: 16 },
  subtasksError: { fontSize: 14, textAlign: 'center', paddingVertical: 16, paddingHorizontal: 16 },
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
