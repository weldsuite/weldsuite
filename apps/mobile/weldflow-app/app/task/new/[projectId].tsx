import { Alert, StyleSheet } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';

import { Screen, ScreenHeader } from '@/components/screen';
import { TaskForm, toCreateTaskInput, type TaskFormValues } from '@/components/TaskForm';
import { useCreateTask } from '@/hooks/use-weldflow';
import { useI18n } from '@/lib/i18n';
import { KEYBOARD_BOTTOM_OFFSET } from '@/lib/keyboard';

export default function NewTaskScreen() {
  const router = useRouter();
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const createTask = useCreateTask(projectId);
  const { t } = useI18n();

  const handleSubmit = async (values: TaskFormValues) => {
    try {
      await createTask.mutateAsync(toCreateTaskInput(values));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch (err) {
      Alert.alert(t.task.createFailed, err instanceof Error ? err.message : t.common.somethingWentWrong);
    }
  };

  return (
    <Screen header={<ScreenHeader title={t.task.newTitle} showBack />}>
      <KeyboardAwareScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        bottomOffset={KEYBOARD_BOTTOM_OFFSET}
      >
        <TaskForm
          mode="create"
          projectId={projectId}
          onSubmit={handleSubmit}
          isSubmitting={createTask.isPending}
        />
      </KeyboardAwareScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 16, paddingBottom: 32 },
});
