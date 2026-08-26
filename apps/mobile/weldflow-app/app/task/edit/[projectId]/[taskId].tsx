import { useMemo } from 'react';
import { Alert, ScrollView, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';

import { Screen, ScreenHeader } from '@/components/screen';
import { DetailSkeleton } from '@/components/data-states';
import { TaskForm, toUpdateTaskInput, type TaskFormValues } from '@/components/TaskForm';
import { useTask, useUpdateTask } from '@/hooks/use-weldflow';
import { useI18n } from '@/lib/i18n';
import type { TaskPriority, TaskStatus } from '@/types/weldflow';

export default function EditTaskScreen() {
  const router = useRouter();
  const { projectId, taskId } = useLocalSearchParams<{ projectId: string; taskId: string }>();
  const { t } = useI18n();

  const { data, isLoading } = useTask(projectId, taskId);
  const updateTask = useUpdateTask(projectId, taskId);
  const task = data?.data;

  const initialValues = useMemo<Partial<TaskFormValues> | undefined>(() => {
    if (!task) return undefined;
    const assignees =
      task.assigneeIds && task.assigneeIds.length > 0
        ? task.assigneeIds
        : task.assigneeId
          ? [task.assigneeId]
          : [];
    return {
      title: task.title,
      description: task.description ?? '',
      priority: (task.priority as TaskPriority) ?? 'medium',
      status: (task.status as TaskStatus) ?? 'todo',
      startDate: task.startDate ?? null,
      dueDate: task.dueDate ?? null,
      estimatedHours: task.estimatedHours ?? '',
      labels: task.labels ?? [],
      assigneeIds: assignees,
    };
  }, [task]);

  const handleSubmit = async (values: TaskFormValues) => {
    try {
      await updateTask.mutateAsync(toUpdateTaskInput(values));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch (err) {
      Alert.alert(t.task.updateFailed, err instanceof Error ? err.message : t.common.somethingWentWrong);
    }
  };

  return (
    <Screen header={<ScreenHeader title={t.task.editTitle} showBack />}>
      {isLoading || !initialValues ? (
        <DetailSkeleton />
      ) : (
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <TaskForm
            mode="edit"
            projectId={projectId}
            initialValues={initialValues}
            onSubmit={handleSubmit}
            isSubmitting={updateTask.isPending}
          />
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 16, paddingBottom: 32 },
});
