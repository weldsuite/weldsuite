import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/ThemeContext';
import { useTask } from '@/contexts/TaskContext';
import { router } from 'expo-router';
import {
  Star,
  ChevronRight,
  CheckCircle2,
  Circle,
} from 'lucide-react-native';
import { useShouldShowMiniSidebar } from '@/components/layout/MiniSidebar';
import { useCollapsibleHeader } from '@/contexts/CollapsibleHeaderContext';
import { TaskDetailPanel } from '@/components/task';
import type { TaskPriority } from '@/types/task.types';

// Split view constants
const SPLIT_VIEW_MIN_WIDTH = 768;
const TASK_LIST_WIDTH = 380;

export default function ImportantScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { tasks, loading, loadTasks, toggleTaskComplete, toggleTaskImportant } = useTask();
  const { width: windowWidth } = useWindowDimensions();
  const showMiniSidebar = useShouldShowMiniSidebar();
  const { onScroll: onCollapsibleScroll, resetHeader } = useCollapsibleHeader();

  // Check if we should show split view (iPad/tablet)
  const isSplitView = windowWidth >= SPLIT_VIEW_MIN_WIDTH;

  const [refreshing, setRefreshing] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  // Reset header when tab becomes active
  useEffect(() => {
    resetHeader();
  }, [resetHeader]);

  useEffect(() => {
    loadTasks({ isImportant: true });
  }, []);

  const importantTasks = tasks.filter((task) => task.isImportant);

  // Auto-select first task when entering split view
  useEffect(() => {
    if (isSplitView && importantTasks.length > 0 && !selectedTaskId) {
      setSelectedTaskId(importantTasks[0].id);
    }
  }, [isSplitView, importantTasks, selectedTaskId]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadTasks({ isImportant: true }, true);
    setRefreshing(false);
  };

  const handleToggleComplete = async (taskId: string) => {
    await toggleTaskComplete(taskId);
  };

  const handleToggleImportant = async (taskId: string) => {
    await toggleTaskImportant(taskId);
    // Clear selection if task is no longer important
    if (selectedTaskId === taskId) {
      const remaining = importantTasks.filter(t => t.id !== taskId);
      setSelectedTaskId(remaining.length > 0 ? remaining[0].id : null);
    }
  };

  const handleTaskPress = (taskId: string) => {
    if (isSplitView) {
      setSelectedTaskId(taskId);
    } else {
      router.push(`/task/task/${taskId}`);
    }
  };

  // Render task list content (used in both layouts)
  const renderTaskListContent = () => (
    <ScrollView
      style={styles.tasksList}
      contentContainerStyle={[styles.tasksContent, { paddingBottom: isSplitView ? 20 : insets.bottom + 100 }]}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#F59E0B" />
      }
      onScroll={!isSplitView ? onCollapsibleScroll : undefined}
      scrollEventThrottle={16}
    >
      {loading.tasks && importantTasks.length === 0 ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#F59E0B" />
          <Text style={[styles.loadingText, { color: colors.muted }]}>Loading important tasks...</Text>
        </View>
      ) : importantTasks.length === 0 ? (
        <View style={styles.emptyState}>
          <Star size={48} color={colors.muted} strokeWidth={1.5} />
          <Text style={[styles.emptyTitle, { color: colors.text }]}>No important tasks</Text>
          <Text style={[styles.emptySubtitle, { color: colors.muted }]}>
            Star a task to mark it as important
          </Text>
        </View>
      ) : (
        importantTasks.map((task) => {
          const isSelected = isSplitView && selectedTaskId === task.id;
          return (
            <TouchableOpacity
              key={task.id}
              style={[
                styles.taskItem,
                {
                  backgroundColor: isSelected ? '#FEF9C3' : colors.background,
                  borderColor: isSelected ? '#F59E0B' : colors.border,
                },
                isSelected && styles.taskItemSelected,
              ]}
              onPress={() => handleTaskPress(task.id)}
            >
              <TouchableOpacity
                style={styles.taskCheckbox}
                onPress={() => handleToggleComplete(task.id)}
              >
                {task.status === 'completed' ? (
                  <CheckCircle2 size={24} color="#22C55E" fill="#22C55E" />
                ) : (
                  <Circle size={24} color={getPriorityColor(task.priority)} strokeWidth={2} />
                )}
              </TouchableOpacity>

              <View style={styles.taskContent}>
                <Text
                  style={[
                    styles.taskTitle,
                    { color: colors.text },
                    task.status === 'completed' && styles.taskTitleCompleted,
                  ]}
                  numberOfLines={1}
                >
                  {task.title}
                </Text>
                <View style={styles.taskMeta}>
                  {task.projectName && (
                    <View style={[styles.projectBadge, { backgroundColor: '#FEF3C7' }]}>
                      <Text style={styles.projectBadgeText}>{task.projectName}</Text>
                    </View>
                  )}
                  {task.dueDate && (
                    <Text style={[styles.taskDue, { color: colors.muted }]}>
                      {formatDate(task.dueDate)}
                    </Text>
                  )}
                </View>
              </View>

              <TouchableOpacity
                style={styles.starButton}
                onPress={() => handleToggleImportant(task.id)}
              >
                <Star size={20} color="#F59E0B" fill="#F59E0B" />
              </TouchableOpacity>

              {!isSplitView && <ChevronRight size={16} color={colors.muted} />}
            </TouchableOpacity>
          );
        })
      )}
    </ScrollView>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {isSplitView ? (
        // Split view for iPad/tablet
        <View style={styles.splitContainer}>
          {/* Left Panel - Task List */}
          <View style={[styles.taskListPanel, { width: TASK_LIST_WIDTH, borderRightColor: colors.border }]}>
            {/* Header */}
            <View style={styles.listHeader}>
              <Text style={[styles.listTitle, { color: colors.text }]}>
                Important ({importantTasks.length})
              </Text>
            </View>
            {renderTaskListContent()}
          </View>

          {/* Right Panel - Task Detail */}
          <View style={styles.taskDetailPanel}>
            <TaskDetailPanel
              taskId={selectedTaskId}
              isEmbedded={true}
            />
          </View>
        </View>
      ) : (
        // Single view for phone
        renderTaskListContent()
      )}
    </View>
  );
}

function getPriorityColor(priority: TaskPriority): string {
  switch (priority) {
    case 'urgent':
      return '#EF4444';
    case 'high':
      return '#F59E0B';
    case 'medium':
      return '#3B82F6';
    case 'low':
    default:
      return '#6B7280';
  }
}

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  if (date.toDateString() === today.toDateString()) {
    return 'Today';
  }
  if (date.toDateString() === tomorrow.toDateString()) {
    return 'Tomorrow';
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  splitContainer: {
    flex: 1,
    flexDirection: 'row',
  },
  taskListPanel: {
    flex: 0,
    borderRightWidth: 0.5,
  },
  taskDetailPanel: {
    flex: 1,
  },
  listHeader: {
    padding: 16,
    paddingBottom: 8,
  },
  listTitle: {
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: -0.3,
  },
  tasksList: {
    flex: 1,
  },
  tasksContent: {
    padding: 16,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 60,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
  },
  emptyState: {
    alignItems: 'center',
    paddingTop: 60,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginTop: 16,
  },
  emptySubtitle: {
    fontSize: 14,
    marginTop: 8,
    textAlign: 'center',
  },
  taskItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 8,
    gap: 12,
  },
  taskItemSelected: {
    borderLeftWidth: 3,
    borderLeftColor: '#F59E0B',
  },
  taskCheckbox: {
    width: 28,
    height: 28,
    justifyContent: 'center',
    alignItems: 'center',
  },
  taskContent: {
    flex: 1,
  },
  taskTitle: {
    fontSize: 15,
    fontWeight: '500',
  },
  taskTitleCompleted: {
    textDecorationLine: 'line-through',
    opacity: 0.6,
  },
  taskMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
  projectBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  projectBadgeText: {
    fontSize: 11,
    color: '#B45309',
    fontWeight: '500',
  },
  taskDue: {
    fontSize: 12,
  },
  starButton: {
    padding: 4,
  },
});
