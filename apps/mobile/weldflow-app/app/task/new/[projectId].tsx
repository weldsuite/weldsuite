import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useCreateTask } from '@/hooks/use-weldflow';
import { TaskForm, toCreateTaskInput, type TaskFormValues } from '@/components/TaskForm';

export default function NewTaskScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const createTask = useCreateTask(projectId);

  const handleSubmit = async (values: TaskFormValues) => {
    try {
      await createTask.mutateAsync(toCreateTaskInput(values));
      router.back();
    } catch (err) {
      Alert.alert('Could not create task', err instanceof Error ? err.message : 'Unknown error');
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <ChevronLeft size={28} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.topTitle, { color: colors.text }]}>New Task</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <TaskForm
          mode="create"
          projectId={projectId}
          onSubmit={handleSubmit}
          isSubmitting={createTask.isPending}
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 4, gap: 4 },
  backBtn: { padding: 4 },
  topTitle: { fontSize: 17, fontWeight: '600' },
  scroll: { padding: 16 },
});
