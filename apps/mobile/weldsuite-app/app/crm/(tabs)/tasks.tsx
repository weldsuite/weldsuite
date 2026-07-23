import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  ScrollView,
  View,
  Text,
  TouchableOpacity,
  TextInput,
  Modal,
  StatusBar,
  FlatList,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  Check,
  Clock,
  Calendar,
  User,
  Search,
  Plus,
  Filter,
  CheckCircle2,
  Circle,
  Building2,
  X,
  ChevronDown,
} from 'lucide-react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import api from '@/services/api';

interface Task {
  id: string;
  title: string;
  description?: string;
  completed: boolean;
  status: 'todo' | 'in-progress' | 'blocked' | 'done';
  assignee?: {
    id: string;
    name: string;
    avatarUrl?: string;
  };
  linkedCompany?: {
    id: string;
    name: string;
    color?: string;
  };
  dueDate?: string;
  createdAt: string;
}

export default function TasksScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [total, setTotal] = useState(0);
  const [searchTerm, setSearchTerm] = useState('');
  const [showCompleted, setShowCompleted] = useState(true);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState<string | null>(null);
  const [isCreateModalVisible, setIsCreateModalVisible] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskDescription, setNewTaskDescription] = useState('');
  const [newTaskStatus, setNewTaskStatus] = useState<'todo' | 'in-progress' | 'blocked' | 'done'>('todo');
  const [newTaskDueDate, setNewTaskDueDate] = useState<Date | undefined>(undefined);
  const [showDatePicker, setShowDatePicker] = useState(false);

  useEffect(() => {
    loadTasks();
  }, [selectedStatus]);

  const loadTasks = async () => {
    try {
      setLoading(true);
      const response = await api.getCrmTasks({
        status: selectedStatus || undefined,
        search: searchTerm || undefined,
      });

      if (response.success && response.data) {
        setTasks(response.data.items as Task[]);
        setTotal(response.data.meta.total);
      }
    } catch (error) {
      console.error('Error loading tasks:', error);
      toast.error('Failed to load tasks');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadTasks();
  };

  const handleSearch = () => {
    loadTasks();
  };

  const parseDate = (dateString?: string): Date | null => {
    if (!dateString) return null;
    return new Date(dateString);
  };

  // Helper functions for date grouping
  const isToday = (date: Date) => {
    const today = new Date();
    return date.toDateString() === today.toDateString();
  };

  const isTomorrow = (date: Date) => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return date.toDateString() === tomorrow.toDateString();
  };

  const isPast = (date: Date) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return date < today;
  };

  const isThisWeek = (date: Date) => {
    const today = new Date();
    const weekFromNow = new Date();
    weekFromNow.setDate(today.getDate() + 7);
    return date > today && date <= weekFromNow;
  };

  const formatDate = (date: Date) => {
    if (isToday(date)) return 'Today';
    if (isTomorrow(date)) return 'Tomorrow';

    const month = date.toLocaleString('default', { month: 'short' });
    const day = date.getDate();
    return `${month} ${day}`;
  };

  // Filter tasks
  const filteredTasks = tasks.filter(task => {
    const matchesSearch =
      task.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      task.linkedCompany?.name.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesStatus = selectedStatus === null || task.status === selectedStatus;

    return matchesSearch && matchesStatus;
  });

  // Group tasks by date
  const overdueTasks = filteredTasks.filter(t => {
    const date = parseDate(t.dueDate);
    return !t.completed && date && isPast(date) && !isToday(date);
  });
  const todayTasks = filteredTasks.filter(t => {
    const date = parseDate(t.dueDate);
    return !t.completed && date && isToday(date);
  });
  const tomorrowTasks = filteredTasks.filter(t => {
    const date = parseDate(t.dueDate);
    return !t.completed && date && isTomorrow(date);
  });
  const thisWeekTasks = filteredTasks.filter(t => {
    const date = parseDate(t.dueDate);
    return !t.completed && date && isThisWeek(date) && !isToday(date) && !isTomorrow(date);
  });
  const laterTasks = filteredTasks.filter(t => {
    const date = parseDate(t.dueDate);
    return !t.completed && date && !isThisWeek(date) && !isPast(date) && !isToday(date) && !isTomorrow(date);
  });
  const noDateTasks = filteredTasks.filter(t =>
    !t.completed && !t.dueDate
  );
  const completedTasks = filteredTasks.filter(t => t.completed);

  const toggleTask = async (taskId: string) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;

    // Optimistic update
    setTasks(tasks.map(t =>
      t.id === taskId ? { ...t, completed: !t.completed } : t
    ));

    try {
      await api.updateCrmTask(taskId, { completed: !task.completed });
    } catch (error) {
      // Revert on error
      setTasks(tasks.map(t =>
        t.id === taskId ? { ...t, completed: task.completed } : t
      ));
      toast.error('Failed to update task');
    }
  };

  const handleTaskClick = (task: Task) => {
    setSelectedTask(task);
    setIsModalVisible(true);
  };

  const handleCreateTask = async () => {
    if (!newTaskTitle.trim()) return;

    try {
      const response = await api.createCrmTask({
        title: newTaskTitle,
        description: newTaskDescription || undefined,
        status: newTaskStatus,
        dueDate: newTaskDueDate?.toISOString(),
      });

      if (response.success && response.data) {
        setTasks([response.data as Task, ...tasks]);
        toast.success('Task created successfully');
      }
    } catch (error) {
      console.error('Error creating task:', error);
      toast.error('Failed to create task');
    }

    setNewTaskTitle('');
    setNewTaskDescription('');
    setNewTaskStatus('todo');
    setNewTaskDueDate(undefined);
    setIsCreateModalVisible(false);
  };

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map(n => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  const renderStatusFilter = () => {
    const statusOptions = [
      { key: null, label: 'All Tasks', count: tasks.length },
      { key: 'todo', label: 'To Do', count: tasks.filter(t => t.status === 'todo').length },
      { key: 'in-progress', label: 'In Progress', count: tasks.filter(t => t.status === 'in-progress').length },
      { key: 'blocked', label: 'Blocked', count: tasks.filter(t => t.status === 'blocked').length },
      { key: 'done', label: 'Done', count: tasks.filter(t => t.status === 'done').length },
    ];

    return (
      <View style={[styles.filterContainer, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterList}>
          {statusOptions.map((item) => (
            <TouchableOpacity
              key={item.key || 'all'}
              style={[
                styles.filterButton,
                {
                  backgroundColor: selectedStatus === item.key ? colors.text : colors.background,
                  borderColor: selectedStatus === item.key ? colors.text : colors.buttonBorder,
                }
              ]}
              onPress={() => setSelectedStatus(item.key)}
            >
              <Text
                style={[
                  styles.filterButtonText,
                  { color: selectedStatus === item.key ? colors.background : colors.text }
                ]}
              >
                {item.label}
              </Text>
              <Text
                style={[
                  styles.filterButtonCount,
                  { color: selectedStatus === item.key ? colors.background : colors.muted }
                ]}
              >
                ({item.count})
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>
    );
  };

  const getStatusConfig = (status?: string) => {
    switch (status) {
      case 'todo':
        return { label: 'To Do', color: '#6B7280', bgColor: '#F3F4F6' };
      case 'in-progress':
        return { label: 'In Progress', color: '#3B82F6', bgColor: '#DBEAFE' };
      case 'blocked':
        return { label: 'Blocked', color: '#EF4444', bgColor: '#FEE2E2' };
      case 'done':
        return { label: 'Done', color: '#10B981', bgColor: '#D1FAE5' };
      default:
        return null;
    }
  };

  const TaskItem = ({ task }: { task: Task }) => {
    const dueDate = parseDate(task.dueDate);
    const isOverdue = dueDate && isPast(dueDate) && !isToday(dueDate);
    const statusConfig = getStatusConfig(task.status);

    return (
      <TouchableOpacity
        style={[styles.taskItem, { backgroundColor: colors.background }]}
        activeOpacity={0.7}
        onPress={() => handleTaskClick(task)}
      >
        <View style={styles.taskRow}>
          <TouchableOpacity
            onPress={(e) => {
              e.stopPropagation();
              toggleTask(task.id);
            }}
            style={[
              styles.checkbox,
              {
                borderColor: task.completed ? '#8B5CF6' : '#D1D5DB',
                backgroundColor: task.completed ? '#8B5CF6' : 'transparent',
              }
            ]}
          >
            {task.completed && (
              <Check size={16} color="#FFFFFF" strokeWidth={2.5} />
            )}
          </TouchableOpacity>

          <View style={styles.taskContent}>
            <Text
              style={[
                styles.taskTitle,
                { color: colors.text },
                task.completed && styles.taskTitleCompleted
              ]}
              numberOfLines={1}
            >
              {task.title}
            </Text>

            <View style={styles.taskMeta}>
              {statusConfig && (
                <View style={[styles.statusBadge, { backgroundColor: statusConfig.bgColor }]}>
                  <Text style={[styles.statusText, { color: statusConfig.color }]}>
                    {statusConfig.label}
                  </Text>
                </View>
              )}

              {task.linkedCompany && (
                <View style={styles.companyBadge}>
                  <View
                    style={[
                      styles.companyDot,
                      { backgroundColor: task.linkedCompany.color || '#6B7280' }
                    ]}
                  />
                  <Text style={[styles.companyText, { color: colors.muted }]}>
                    {task.linkedCompany.name}
                  </Text>
                </View>
              )}

              {dueDate && (
                <View style={styles.dueDateBadge}>
                  <Calendar
                    size={11}
                    color={isOverdue ? '#EF4444' : colors.muted}
                    strokeWidth={2}
                  />
                  <Text
                    style={[
                      styles.dueDateText,
                      { color: isOverdue ? '#EF4444' : colors.muted }
                    ]}
                  >
                    {formatDate(dueDate)}
                  </Text>
                </View>
              )}

              {task.assignee && (
                <View style={[styles.avatar, { backgroundColor: '#F3F4F6' }]}>
                  <Text style={styles.avatarText}>
                    {getInitials(task.assignee.name)}
                  </Text>
                </View>
              )}
            </View>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  const TaskSection = ({ title, tasks }: { title: string; tasks: Task[] }) => {
    if (tasks.length === 0) return null;

    return (
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.muted }]}>
            {title}
          </Text>
          <View style={[styles.countBadge, { backgroundColor: '#F3F4F6' }]}>
            <Text style={[styles.countText, { color: '#6B7280' }]}>
              {tasks.length}
            </Text>
          </View>
        </View>

        <View style={styles.taskList}>
          {tasks.map(task => (
            <TaskItem key={task.id} task={task} />
          ))}
        </View>
      </View>
    );
  };

  // Stats
  const totalTasks = tasks.filter(t => !t.completed).length;
  const completedCount = tasks.filter(t => t.completed).length;

  if (loading && !refreshing) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>Loading tasks...</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Tasks ({filteredTasks.length})</Text>
        <TouchableOpacity
          style={[styles.addButton, { backgroundColor: colors.background, borderColor: colors.buttonBorder }]}
          onPress={() => setIsCreateModalVisible(true)}
        >
          <Plus size={16} color={colors.text} strokeWidth={2} />
          <Text style={[styles.addButtonText, { color: colors.text }]}>Add</Text>
        </TouchableOpacity>
      </View>

      {/* Search Bar */}
      <View style={[styles.searchBarContainer, { backgroundColor: colors.background, borderBottomColor: colors.divider }]}>
        <View style={[styles.searchBar, { backgroundColor: '#F3F4F6' }]}>
          <Ionicons name="search" size={16} color={colors.muted} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search tasks, companies..."
            placeholderTextColor={colors.muted}
            value={searchTerm}
            onChangeText={setSearchTerm}
            onSubmitEditing={handleSearch}
            returnKeyType="search"
          />
        </View>
      </View>

      {renderStatusFilter()}

      {/* Task List */}
      <ScrollView
        style={styles.scrollView}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
      >
        {overdueTasks.length > 0 && <TaskSection title="Overdue" tasks={overdueTasks} />}
        {todayTasks.length > 0 && <TaskSection title="Today" tasks={todayTasks} />}
        {tomorrowTasks.length > 0 && <TaskSection title="Tomorrow" tasks={tomorrowTasks} />}
        {thisWeekTasks.length > 0 && <TaskSection title="This week" tasks={thisWeekTasks} />}
        {laterTasks.length > 0 && <TaskSection title="Later" tasks={laterTasks} />}
        {noDateTasks.length > 0 && <TaskSection title="No date" tasks={noDateTasks} />}
        {showCompleted && completedTasks.length > 0 && (
          <TaskSection title="Completed" tasks={completedTasks} />
        )}

        {filteredTasks.length === 0 && (
          <View style={styles.emptyState}>
            <View style={[styles.emptyCheckbox, { borderColor: colors.divider }]}>
              <Check size={32} color={colors.muted} strokeWidth={1.5} />
            </View>
            <Text style={[styles.emptyTitle, { color: colors.text }]}>
              No tasks found
            </Text>
            <Text style={[styles.emptyText, { color: colors.muted }]}>
              Create a new task or adjust your filters
            </Text>
          </View>
        )}
      </ScrollView>

      {/* Task Details Modal */}
      <Modal
        visible={isModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setIsModalVisible(false)}
      >
        <StatusBar barStyle="light-content" />
        <SafeAreaView style={[styles.modalContainer, { backgroundColor: colors.background }]}>
          {/* Modal Header */}
          <View style={[styles.modalHeader, { borderBottomColor: colors.divider }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>Task Details</Text>
            <TouchableOpacity
              onPress={() => setIsModalVisible(false)}
              style={styles.closeButton}
            >
              <X size={20} color={colors.text} strokeWidth={2} />
            </TouchableOpacity>
          </View>

          {/* Modal Content */}
          {selectedTask && (
            <ScrollView style={styles.modalContent} showsVerticalScrollIndicator={false}>
              {/* Task Title */}
              <View style={styles.modalSection}>
                <Text style={[styles.modalLabel, { color: colors.muted }]}>Title</Text>
                <Text style={[styles.modalTaskTitle, { color: colors.text }]}>
                  {selectedTask.title}
                </Text>
              </View>

              {/* Description */}
              {selectedTask.description && (
                <View style={styles.modalSection}>
                  <Text style={[styles.modalLabel, { color: colors.muted }]}>Description</Text>
                  <Text style={[styles.modalText, { color: colors.text }]}>
                    {selectedTask.description}
                  </Text>
                </View>
              )}

              {/* Status */}
              {selectedTask.status && (
                <View style={styles.modalSection}>
                  <Text style={[styles.modalLabel, { color: colors.muted }]}>Status</Text>
                  <View style={styles.modalRow}>
                    {(() => {
                      const statusConfig = getStatusConfig(selectedTask.status);
                      return statusConfig ? (
                        <View style={[styles.statusBadge, { backgroundColor: statusConfig.bgColor }]}>
                          <Text style={[styles.statusText, { color: statusConfig.color }]}>
                            {statusConfig.label}
                          </Text>
                        </View>
                      ) : null;
                    })()}
                  </View>
                </View>
              )}

              {/* Company */}
              {selectedTask.linkedCompany && (
                <View style={styles.modalSection}>
                  <Text style={[styles.modalLabel, { color: colors.muted }]}>Company</Text>
                  <View style={styles.modalRow}>
                    <View
                      style={[
                        styles.companyDot,
                        { backgroundColor: selectedTask.linkedCompany.color || '#6B7280' }
                      ]}
                    />
                    <Text style={[styles.modalText, { color: colors.text }]}>
                      {selectedTask.linkedCompany.name}
                    </Text>
                  </View>
                </View>
              )}

              {/* Due Date */}
              {selectedTask.dueDate && (
                <View style={styles.modalSection}>
                  <Text style={[styles.modalLabel, { color: colors.muted }]}>Due Date</Text>
                  <View style={styles.modalRow}>
                    <Calendar size={16} color={colors.text} strokeWidth={2} />
                    <Text style={[styles.modalText, { color: colors.text }]}>
                      {parseDate(selectedTask.dueDate) ? formatDate(parseDate(selectedTask.dueDate)!) : selectedTask.dueDate}
                    </Text>
                  </View>
                </View>
              )}

              {/* Assignee */}
              {selectedTask.assignee && (
                <View style={styles.modalSection}>
                  <Text style={[styles.modalLabel, { color: colors.muted }]}>Assignee</Text>
                  <View style={styles.modalRow}>
                    <View style={[styles.avatar, { backgroundColor: '#F3F4F6' }]}>
                      <Text style={styles.avatarText}>
                        {getInitials(selectedTask.assignee.name)}
                      </Text>
                    </View>
                    <Text style={[styles.modalText, { color: colors.text }]}>
                      {selectedTask.assignee.name}
                    </Text>
                  </View>
                </View>
              )}

              {/* Created At */}
              <View style={styles.modalSection}>
                <Text style={[styles.modalLabel, { color: colors.muted }]}>Created</Text>
                <Text style={[styles.modalText, { color: colors.text }]}>
                  {new Date(selectedTask.createdAt).toLocaleDateString('en-US', {
                    month: 'long',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </Text>
              </View>
            </ScrollView>
          )}
        </SafeAreaView>
      </Modal>

      {/* Create Task Modal */}
      <Modal
        visible={isCreateModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setIsCreateModalVisible(false)}
      >
        <StatusBar barStyle="light-content" />
        <SafeAreaView style={[styles.modalContainer, { backgroundColor: colors.background }]}>
          {/* Modal Header */}
          <View style={[styles.modalHeader, { borderBottomColor: colors.divider }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>New Task</Text>
            <TouchableOpacity
              onPress={() => setIsCreateModalVisible(false)}
              style={styles.closeButton}
            >
              <X size={20} color={colors.text} strokeWidth={2} />
            </TouchableOpacity>
          </View>

          {/* Modal Content */}
          <ScrollView style={styles.modalContent} showsVerticalScrollIndicator={false}>
            {/* Task Title */}
            <View style={styles.modalSection}>
              <Text style={[styles.modalLabel, { color: '#374151' }]}>Title</Text>
              <TextInput
                style={[styles.modalInput, { color: colors.text }]}
                placeholder="Enter task title"
                placeholderTextColor={colors.muted}
                value={newTaskTitle}
                onChangeText={setNewTaskTitle}
              />
            </View>

            {/* Description */}
            <View style={styles.modalSection}>
              <Text style={[styles.modalLabel, { color: '#374151' }]}>Description (Optional)</Text>
              <TextInput
                style={[styles.modalTextArea, { color: colors.text }]}
                placeholder="Enter task description"
                placeholderTextColor={colors.muted}
                value={newTaskDescription}
                onChangeText={setNewTaskDescription}
                multiline
                numberOfLines={4}
                textAlignVertical="top"
              />
            </View>

            {/* Status */}
            <View style={styles.modalSection}>
              <Text style={[styles.modalLabel, { color: '#374151' }]}>Status</Text>
              <View style={styles.statusOptions}>
                {(['todo', 'in-progress', 'blocked', 'done'] as const).map((status) => {
                  const statusConfig = getStatusConfig(status);
                  const isSelected = newTaskStatus === status;
                  return (
                    <TouchableOpacity
                      key={status}
                      style={[
                        styles.statusOption,
                        {
                          backgroundColor: isSelected ? statusConfig?.bgColor : colors.background,
                          borderColor: isSelected ? statusConfig?.color : '#E5E7EB',
                        }
                      ]}
                      onPress={() => setNewTaskStatus(status)}
                    >
                      <Text
                        style={[
                          styles.statusOptionText,
                          { color: isSelected ? statusConfig?.color : colors.text }
                        ]}
                      >
                        {statusConfig?.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {/* Due Date */}
            <View style={styles.modalSection}>
              <Text style={[styles.modalLabel, { color: '#374151' }]}>Due Date (Optional)</Text>
              <View style={styles.dateOptions}>
                <TouchableOpacity
                  style={[
                    styles.dateOption,
                    {
                      backgroundColor: newTaskDueDate && isToday(newTaskDueDate) ? '#DBEAFE' : colors.background,
                      borderColor: newTaskDueDate && isToday(newTaskDueDate) ? '#3B82F6' : '#E5E7EB',
                    }
                  ]}
                  onPress={() => setNewTaskDueDate(new Date())}
                >
                  <Text style={[styles.dateOptionText, { color: newTaskDueDate && isToday(newTaskDueDate) ? '#3B82F6' : colors.text }]}>
                    Today
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.dateOption,
                    {
                      backgroundColor: newTaskDueDate && isTomorrow(newTaskDueDate) ? '#DBEAFE' : colors.background,
                      borderColor: newTaskDueDate && isTomorrow(newTaskDueDate) ? '#3B82F6' : '#E5E7EB',
                    }
                  ]}
                  onPress={() => {
                    const tomorrow = new Date();
                    tomorrow.setDate(tomorrow.getDate() + 1);
                    setNewTaskDueDate(tomorrow);
                  }}
                >
                  <Text style={[styles.dateOptionText, { color: newTaskDueDate && isTomorrow(newTaskDueDate) ? '#3B82F6' : colors.text }]}>
                    Tomorrow
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.dateOption,
                    {
                      backgroundColor: newTaskDueDate && isThisWeek(newTaskDueDate) && !isToday(newTaskDueDate) && !isTomorrow(newTaskDueDate) ? '#DBEAFE' : colors.background,
                      borderColor: newTaskDueDate && isThisWeek(newTaskDueDate) && !isToday(newTaskDueDate) && !isTomorrow(newTaskDueDate) ? '#3B82F6' : '#E5E7EB',
                    }
                  ]}
                  onPress={() => {
                    const nextWeek = new Date();
                    nextWeek.setDate(nextWeek.getDate() + 7);
                    setNewTaskDueDate(nextWeek);
                  }}
                >
                  <Text style={[styles.dateOptionText, { color: newTaskDueDate && isThisWeek(newTaskDueDate) && !isToday(newTaskDueDate) && !isTomorrow(newTaskDueDate) ? '#3B82F6' : colors.text }]}>
                    This Week
                  </Text>
                </TouchableOpacity>
              </View>
              {newTaskDueDate && (
                <TouchableOpacity
                  style={styles.clearDateButton}
                  onPress={() => setNewTaskDueDate(undefined)}
                >
                  <Text style={[styles.clearDateText, { color: colors.muted }]}>Clear date</Text>
                </TouchableOpacity>
              )}
            </View>
          </ScrollView>

          {/* Create Button */}
          <View style={[styles.createButtonContainer, { backgroundColor: colors.background }]}>
            <TouchableOpacity
              style={[styles.createButton, { backgroundColor: '#000000' }]}
              onPress={handleCreateTask}
            >
              <Text style={styles.createButtonText}>Create Task</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingText: {
    marginTop: 16,
    fontSize: 12,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: -0.3,
  },
  searchBarContainer: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    fontWeight: '400',
  },
  filterContainer: {
    paddingTop: 4,
    paddingBottom: 12,
  },
  filterList: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
  },
  filterButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    gap: 4,
  },
  filterButtonText: {
    fontSize: 13,
    fontWeight: '500',
  },
  filterButtonCount: {
    fontSize: 13,
    fontWeight: '400',
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  addButtonText: {
    fontSize: 13,
    fontWeight: '500',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 20,
  },
  section: {
    marginBottom: 24,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
  },
  countBadge: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 5,
    justifyContent: 'center',
    alignItems: 'center',
  },
  countText: {
    fontSize: 9,
    fontWeight: '600',
  },
  taskList: {
    gap: 2,
  },
  taskItem: {
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 0,
  },
  taskRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1.25,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: -1,
  },
  taskContent: {
    flex: 1,
    gap: 6,
  },
  taskTitle: {
    fontSize: 14,
    fontWeight: '500',
  },
  taskTitleCompleted: {
    textDecorationLine: 'line-through',
    opacity: 0.5,
  },
  taskMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  companyBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  companyDot: {
    width: 8,
    height: 8,
    borderRadius: 2,
  },
  companyText: {
    fontSize: 11,
  },
  statusBadge: {
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 10,
    fontWeight: '600',
  },
  dueDateBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  dueDateText: {
    fontSize: 11,
  },
  avatar: {
    width: 20,
    height: 20,
    borderRadius: 4,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    fontSize: 8,
    fontWeight: '600',
    color: '#6B7280',
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 80,
    paddingHorizontal: 40,
  },
  emptyCheckbox: {
    width: 64,
    height: 64,
    borderRadius: 8,
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginTop: 16,
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 13,
    textAlign: 'center',
  },
  modalContainer: {
    flex: 1,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingTop: 16,
    borderBottomWidth: 1,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '600',
    marginLeft: 16,
  },
  closeButton: {
    padding: 4,
    marginRight: 16,
  },
  modalContent: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  modalSection: {
    marginBottom: 24,
  },
  modalLabel: {
    fontSize: 13,
    fontWeight: '500',
    marginBottom: 6,
  },
  modalTaskTitle: {
    fontSize: 18,
    fontWeight: '600',
    lineHeight: 24,
  },
  modalText: {
    fontSize: 15,
    lineHeight: 22,
  },
  modalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  modalInput: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  modalTextArea: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    minHeight: 100,
    textAlignVertical: 'top',
  },
  createButtonContainer: {
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  createButton: {
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  createButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  statusOptions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  statusOption: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 1,
  },
  statusOptionText: {
    fontSize: 13,
    fontWeight: '500',
  },
  dateOptions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  dateOption: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 1,
  },
  dateOptionText: {
    fontSize: 13,
    fontWeight: '500',
  },
  clearDateButton: {
    marginTop: 8,
    alignSelf: 'flex-start',
  },
  clearDateText: {
    fontSize: 13,
    textDecorationLine: 'underline',
  },
});
