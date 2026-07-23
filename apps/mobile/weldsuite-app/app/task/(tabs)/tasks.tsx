import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  TextInput,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/ThemeContext';
import { useTask } from '@/contexts/TaskContext';
import { router } from 'expo-router';
import {
  Search,
  Filter,
  Plus,
  ChevronRight,
  Star,
  CheckCircle2,
  Circle,
} from 'lucide-react-native';
import { useShouldShowMiniSidebar } from '@/components/layout/MiniSidebar';
import { useCollapsibleHeader } from '@/contexts/CollapsibleHeaderContext';
import { TaskDetailPanel } from '@/components/task';
import type { TaskStatus, TaskPriority } from '@/types/task.types';

// Split view constants
const SPLIT_VIEW_MIN_WIDTH = 768;
const TASK_LIST_WIDTH = 380;

const STATUS_FILTERS: { label: string; value: TaskStatus | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'To Do', value: 'todo' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Completed', value: 'completed' },
];

export default function TasksScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { tasks, loading, loadTasks, toggleTaskComplete, toggleTaskImportant } = useTask();
  const { width: windowWidth } = useWindowDimensions();
  const showMiniSidebar = useShouldShowMiniSidebar();
  const { onScroll: onCollapsibleScroll, resetHeader } = useCollapsibleHeader();

  // Check if we should show split view (iPad/tablet)
  const isSplitView = windowWidth >= SPLIT_VIEW_MIN_WIDTH;

  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<TaskStatus | 'all'>('all');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  // Reset header when tab becomes active
  useEffect(() => {
    resetHeader();
  }, [resetHeader]);

  useEffect(() => {
    loadTasks();
  }, []);

  // Auto-select first task when entering split view
  useEffect(() => {
    if (isSplitView && tasks.length > 0 && !selectedTaskId) {
      setSelectedTaskId(tasks[0].id);
    }
  }, [isSplitView, tasks, selectedTaskId]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadTasks({}, true);
    setRefreshing(false);
  };

  const filteredTasks = tasks.filter((task) => {
    const matchesSearch =
      searchQuery === '' ||
      task.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      task.description?.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesStatus = statusFilter === 'all' || task.status === statusFilter;

    return matchesSearch && matchesStatus;
  });

  const handleToggleComplete = async (taskId: string) => {
    await toggleTaskComplete(taskId);
  };

  const handleToggleImportant = async (taskId: string) => {
    await toggleTaskImportant(taskId);
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
    <>
      {/* Search Bar */}
      <View style={styles.searchContainer}>
        <View style={[styles.searchBar, { backgroundColor: '#F3F4F6' }]}>
          <Search size={18} color={colors.muted} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search tasks..."
            placeholderTextColor={colors.muted}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </View>
        <TouchableOpacity style={[styles.filterButton, { borderColor: colors.border }]}>
          <Filter size={18} color={colors.text} />
        </TouchableOpacity>
      </View>

      {/* Status Filters */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filtersContainer}
        contentContainerStyle={styles.filtersContent}
      >
        {STATUS_FILTERS.map((filter) => (
          <TouchableOpacity
            key={filter.value}
            style={[
              styles.filterChip,
              statusFilter === filter.value
                ? { backgroundColor: '#8B5CF6' }
                : { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border },
            ]}
            onPress={() => setStatusFilter(filter.value)}
          >
            <Text
              style={[
                styles.filterChipText,
                { color: statusFilter === filter.value ? '#FFFFFF' : colors.text },
              ]}
            >
              {filter.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Tasks List */}
      <ScrollView
        style={styles.tasksList}
        contentContainerStyle={[styles.tasksContent, { paddingBottom: isSplitView ? 20 : insets.bottom + 100 }]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#8B5CF6" />
        }
        onScroll={!isSplitView ? onCollapsibleScroll : undefined}
        scrollEventThrottle={16}
      >
        {loading.tasks && tasks.length === 0 ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#8B5CF6" />
            <Text style={[styles.loadingText, { color: colors.muted }]}>Loading tasks...</Text>
          </View>
        ) : filteredTasks.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={[styles.emptyTitle, { color: colors.text }]}>No tasks found</Text>
            <Text style={[styles.emptySubtitle, { color: colors.muted }]}>
              {searchQuery ? 'Try a different search term' : 'Create a new task to get started'}
            </Text>
          </View>
        ) : (
          filteredTasks.map((task) => {
            const isSelected = isSplitView && selectedTaskId === task.id;
            return (
              <TouchableOpacity
                key={task.id}
                style={[
                  styles.taskItem,
                  {
                    backgroundColor: isSelected ? '#EEF2FF' : colors.background,
                    borderColor: isSelected ? '#8B5CF6' : colors.border,
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
                      <View style={[styles.projectBadge, { backgroundColor: '#EEF2FF' }]}>
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
                  <Star
                    size={18}
                    color={task.isImportant ? '#F59E0B' : colors.muted}
                    fill={task.isImportant ? '#F59E0B' : 'transparent'}
                  />
                </TouchableOpacity>

                {!isSplitView && <ChevronRight size={16} color={colors.muted} />}
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>
    </>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {isSplitView ? (
        // Split view for iPad/tablet
        <View style={styles.splitContainer}>
          {/* Left Panel - Task List */}
          <View style={[styles.taskListPanel, { width: TASK_LIST_WIDTH, borderRightColor: colors.border }]}>
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
        <>
          {renderTaskListContent()}

          {/* FAB */}
          <TouchableOpacity
            style={styles.fab}
            onPress={() => router.push('/task/create')}
          >
            <Plus size={24} color="#FFFFFF" strokeWidth={2} />
          </TouchableOpacity>
        </>
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
  searchContainer: {
    flexDirection: 'row',
    padding: 16,
    gap: 12,
  },
  searchBar: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
  },
  filterButton: {
    width: 44,
    height: 44,
    borderRadius: 10,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  filtersContainer: {
    maxHeight: 44,
  },
  filtersContent: {
    paddingHorizontal: 16,
    gap: 8,
  },
  filterChip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    marginRight: 8,
  },
  filterChipText: {
    fontSize: 14,
    fontWeight: '500',
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
  },
  emptySubtitle: {
    fontSize: 14,
    marginTop: 8,
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
    borderLeftColor: '#8B5CF6',
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
    color: '#6366F1',
    fontWeight: '500',
  },
  taskDue: {
    fontSize: 12,
  },
  starButton: {
    padding: 4,
  },
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 100,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#8B5CF6',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#8B5CF6',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
});
