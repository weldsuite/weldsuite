import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useTask, useUpdateTask } from '@/hooks/use-weldflow';
import { TaskForm, toUpdateTaskInput, type TaskFormValues } from '@/components/TaskForm';
import type { TaskPriority, TaskStatus } from '@/types/weldflow';

export default function EditTaskScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { projectId, taskId } = useLocalSearchParams<{ projectId: string; taskId: string }>();

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
      router.back();
    } catch (err) {
      Alert.alert('Could not save changes', err instanceof Error ? err.message : 'Unknown error');
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <ChevronLeft size={28} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.topTitle, { color: colors.text }]}>Edit Task</Text>
      </View>

      {isLoading || !initialValues ? (
        <View style={styles.loading}>
          <ActivityIndicator size="large" color="#6366F1" />
        </View>
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 4, gap: 4 },
  backBtn: { padding: 4 },
  topTitle: { fontSize: 17, fontWeight: '600' },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  scroll: { padding: 16 },
});
