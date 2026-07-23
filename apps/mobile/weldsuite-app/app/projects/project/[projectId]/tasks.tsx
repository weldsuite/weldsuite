import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  ScrollView,
  View,
  Text,
  TouchableOpacity,
  TextInput,
  Modal,
  StatusBar,
  RefreshControl,
  ActivityIndicator,
  Animated,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  Check,
  Calendar,
  X,
  Plus,
  ChevronDown,
  Pencil,
  Trash2,
} from 'lucide-react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { useLocalSearchParams } from 'expo-router';
import api from '@/services/api';

interface Task {
  id: string;
  title: string;
  description?: string;
  completed: boolean;
  status: 'todo' | 'in_progress' | 'review' | 'done' | 'cancelled';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  assignee?: {
    id: string;
    name: string;
    avatarUrl?: string;
  };
  dueDate?: string;
  createdAt: string;
}

export default function ProjectTasksScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const { projectId } = useLocalSearchParams();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [showCompleted, setShowCompleted] = useState(true);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState<string | null>(null);
  const [isCreateModalVisible, setIsCreateModalVisible] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskDescription, setNewTaskDescription] = useState('');
  const [newTaskStatus, setNewTaskStatus] = useState<'todo' | 'in_progress' | 'review' | 'done'>('todo');
  const [newTaskPriority, setNewTaskPriority] = useState<'low' | 'medium' | 'high' | 'urgent'>('medium');
  const [newTaskDueDate, setNewTaskDueDate] = useState<Date | undefined>(undefined);
  const [showStatusDropdown, setShowStatusDropdown] = useState(false);
  const [showPriorityDropdown, setShowPriorityDropdown] = useState(false);
  const [newTaskTag, setNewTaskTag] = useState('');
  const [newTaskTags, setNewTaskTags] = useState<string[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [members, setMembers] = useState<{ id: string; userId: string; name?: string; email?: string; role?: string }[]>([]);
  const [selectedAssignee, setSelectedAssignee] = useState<string | null>(null);
  const [showAssigneeDropdown, setShowAssigneeDropdown] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  // Edit modal state
  const [isEditing, setIsEditing] = useState(false);
  const [editTaskTitle, setEditTaskTitle] = useState('');
  const [editTaskDescription, setEditTaskDescription] = useState('');
  const [editTaskStatus, setEditTaskStatus] = useState<'todo' | 'in_progress' | 'review' | 'done'>('todo');
  const [editTaskPriority, setEditTaskPriority] = useState<'low' | 'medium' | 'high' | 'urgent'>('medium');
  const [editTaskAssignee, setEditTaskAssignee] = useState<string | null>(null);
  const [showEditStatusDropdown, setShowEditStatusDropdown] = useState(false);
  const [showEditPriorityDropdown, setShowEditPriorityDropdown] = useState(false);
  const [showEditAssigneeDropdown, setShowEditAssigneeDropdown] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (isCreateModalVisible) {
      setShowCreateModal(true);
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 150,
        useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 150,
        useNativeDriver: true,
      }).start(() => setShowCreateModal(false));
    }
  }, [isCreateModalVisible]);

  useEffect(() => {
    loadTasks();
    loadMembers();
  }, [projectId, selectedStatus]);

  const loadMembers = async () => {
    try {
      const response = await api.getProjectMembers(projectId as string);
      if (response.success && response.data) {
        setMembers(response.data);
      }
    } catch (error) {
      console.error('Error loading members:', error);
    }
  };

  const loadTasks = async () => {
    try {
      setLoading(true);
      const response = await api.getProjectTasks(projectId as string, {
        status: selectedStatus || undefined,
        search: searchTerm || undefined,
        limit: 100,
      });

      if (response.success && response.data) {
        const items = response.data.items || [];
        const mappedTasks = items.map((task: any) => ({
          ...task,
          completed: task.status === 'done',
        }));
        setTasks(mappedTasks);
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

  const filteredTasks = tasks.filter(task => {
    const matchesSearch = task.title.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = selectedStatus === null || task.status === selectedStatus;
    return matchesSearch && matchesStatus;
  });

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
  const noDateTasks = filteredTasks.filter(t => !t.completed && !t.dueDate);
  const completedTasks = filteredTasks.filter(t => t.completed);

  const toggleTask = async (taskId: string) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;

    const newStatus = task.completed ? 'todo' : 'done';

    setTasks(tasks.map(t =>
      t.id === taskId ? { ...t, completed: !t.completed, status: newStatus } : t
    ));

    try {
      await api.updateProjectTask(projectId as string, taskId, { status: newStatus });
    } catch (error) {
      setTasks(tasks.map(t =>
        t.id === taskId ? { ...t, completed: task.completed, status: task.status } : t
      ));
      toast.error('Failed to update task');
    }
  };

  const handleTaskClick = (task: Task) => {
    setSelectedTask(task);
    setIsModalVisible(true);
  };

  const handleCreateTask = async () => {
    if (!newTaskTitle.trim() || isCreating) return;

    setIsCreating(true);
    try {
      const response = await api.createProjectTask(projectId as string, {
        title: newTaskTitle,
        description: newTaskDescription || undefined,
        status: newTaskStatus,
        priority: newTaskPriority,
        dueDate: newTaskDueDate?.toISOString(),
        assigneeId: selectedAssignee || undefined,
      });

      if (response.success && response.data) {
        const newTask = {
          ...response.data,
          completed: response.data.status === 'done',
        } as Task;
        setTasks([newTask, ...tasks]);
        toast.success('Task created successfully');
      }

      setNewTaskTitle('');
      setNewTaskDescription('');
      setNewTaskStatus('todo');
      setNewTaskPriority('medium');
      setNewTaskDueDate(undefined);
      setSelectedAssignee(null);
      setNewTaskTag('');
      setNewTaskTags([]);
      setIsCreateModalVisible(false);
    } catch (error) {
      console.error('Error creating task:', error);
      toast.error('Failed to create task');
    } finally {
      setIsCreating(false);
    }
  };

  const handleAddTag = () => {
    if (newTaskTag.trim() && !newTaskTags.includes(newTaskTag.trim())) {
      setNewTaskTags([...newTaskTags, newTaskTag.trim()]);
      setNewTaskTag('');
    }
  };

  const handleRemoveTag = (tag: string) => {
    setNewTaskTags(newTaskTags.filter(t => t !== tag));
  };

  const startEditing = () => {
    if (!selectedTask) return;
    setEditTaskTitle(selectedTask.title);
    setEditTaskDescription(selectedTask.description || '');
    setEditTaskStatus(selectedTask.status as 'todo' | 'in_progress' | 'review' | 'done');
    setEditTaskPriority(selectedTask.priority);
    setEditTaskAssignee(selectedTask.assignee?.id || null);
    setIsEditing(true);
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setShowEditStatusDropdown(false);
    setShowEditPriorityDropdown(false);
    setShowEditAssigneeDropdown(false);
  };

  const handleSaveTask = async () => {
    if (!selectedTask || !editTaskTitle.trim() || isSaving) return;

    setIsSaving(true);
    try {
      const response = await api.updateProjectTask(projectId as string, selectedTask.id, {
        title: editTaskTitle.trim(),
        description: editTaskDescription.trim() || undefined,
        status: editTaskStatus,
        priority: editTaskPriority,
        assigneeId: editTaskAssignee || undefined,
      });

      if (response.success) {
        // Update local state
        setTasks(tasks.map(t =>
          t.id === selectedTask.id
            ? {
                ...t,
                title: editTaskTitle.trim(),
                description: editTaskDescription.trim(),
                status: editTaskStatus,
                priority: editTaskPriority,
                completed: editTaskStatus === 'done',
                assignee: editTaskAssignee
                  ? { id: editTaskAssignee, name: members.find(m => m.userId === editTaskAssignee)?.name || '' }
                  : undefined,
              }
            : t
        ));

        // Update selected task
        setSelectedTask({
          ...selectedTask,
          title: editTaskTitle.trim(),
          description: editTaskDescription.trim(),
          status: editTaskStatus,
          priority: editTaskPriority,
          completed: editTaskStatus === 'done',
          assignee: editTaskAssignee
            ? { id: editTaskAssignee, name: members.find(m => m.userId === editTaskAssignee)?.name || '' }
            : undefined,
        });

        toast.success('Task updated');
        setIsEditing(false);
      }
    } catch (error) {
      console.error('Error updating task:', error);
      toast.error('Failed to update task');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteTask = () => {
    if (!selectedTask) return;

    Alert.alert(
      'Delete Task',
      `Are you sure you want to delete "${selectedTask.title}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: confirmDeleteTask,
        },
      ]
    );
  };

  const confirmDeleteTask = async () => {
    if (!selectedTask || isDeleting) return;

    setIsDeleting(true);
    try {
      const response = await api.deleteProjectTask(projectId as string, selectedTask.id);

      if (response.success) {
        setTasks(tasks.filter(t => t.id !== selectedTask.id));
        toast.success('Task deleted');
        setIsModalVisible(false);
        setSelectedTask(null);
      }
    } catch (error) {
      console.error('Error deleting task:', error);
      toast.error('Failed to delete task');
    } finally {
      setIsDeleting(false);
    }
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
      { key: 'in_progress', label: 'In Progress', count: tasks.filter(t => t.status === 'in_progress').length },
      { key: 'review', label: 'Review', count: tasks.filter(t => t.status === 'review').length },
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
      case 'in_progress':
        return { label: 'In Progress', color: '#3B82F6', bgColor: '#DBEAFE' };
      case 'review':
        return { label: 'Review', color: '#8B5CF6', bgColor: '#EDE9FE' };
      case 'done':
        return { label: 'Done', color: '#10B981', bgColor: '#D1FAE5' };
      case 'cancelled':
        return { label: 'Cancelled', color: '#6B7280', bgColor: '#F3F4F6' };
      default:
        return null;
    }
  };

  const getPriorityConfig = (priority?: string) => {
    switch (priority) {
      case 'low':
        return { label: 'Low', color: '#6B7280', bgColor: '#F3F4F6' };
      case 'medium':
        return { label: 'Medium', color: '#3B82F6', bgColor: '#DBEAFE' };
      case 'high':
        return { label: 'High', color: '#F59E0B', bgColor: '#FEF3C7' };
      case 'urgent':
        return { label: 'Urgent', color: '#EF4444', bgColor: '#FEE2E2' };
      default:
        return null;
    }
  };

  const TaskItem = ({ task }: { task: Task }) => {
    const dueDate = parseDate(task.dueDate);
    const isOverdue = dueDate && isPast(dueDate) && !isToday(dueDate);
    const statusConfig = getStatusConfig(task.status);
    const priorityConfig = getPriorityConfig(task.priority);

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

              {priorityConfig && (
                <View style={[styles.statusBadge, { backgroundColor: priorityConfig.bgColor }]}>
                  <Text style={[styles.statusText, { color: priorityConfig.color }]}>
                    {priorityConfig.label}
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
            placeholder="Search tasks..."
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
        onRequestClose={() => {
          setIsModalVisible(false);
          setIsEditing(false);
        }}
      >
        <StatusBar barStyle="light-content" />
        <SafeAreaView style={[styles.modalContainer, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.divider }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>
              {isEditing ? 'Edit Task' : 'Task Details'}
            </Text>
            <View style={styles.modalHeaderActions}>
              {!isEditing && (
                <>
                  <TouchableOpacity
                    onPress={startEditing}
                    style={styles.headerIconButton}
                  >
                    <Pencil size={18} color={colors.text} strokeWidth={2} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={handleDeleteTask}
                    style={styles.headerIconButton}
                    disabled={isDeleting}
                  >
                    {isDeleting ? (
                      <ActivityIndicator size="small" color="#EF4444" />
                    ) : (
                      <Trash2 size={18} color="#EF4444" strokeWidth={2} />
                    )}
                  </TouchableOpacity>
                </>
              )}
              <TouchableOpacity
                onPress={() => {
                  setIsModalVisible(false);
                  setIsEditing(false);
                }}
                style={styles.closeButton}
              >
                <X size={20} color={colors.text} strokeWidth={2} />
              </TouchableOpacity>
            </View>
          </View>

          {selectedTask && !isEditing && (
            <ScrollView style={styles.modalContent} showsVerticalScrollIndicator={false}>
              <View style={styles.modalSection}>
                <Text style={[styles.modalLabel, { color: colors.muted }]}>Title</Text>
                <Text style={[styles.modalTaskTitle, { color: colors.text }]}>
                  {selectedTask.title}
                </Text>
              </View>

              {selectedTask.description && (
                <View style={styles.modalSection}>
                  <Text style={[styles.modalLabel, { color: colors.muted }]}>Description</Text>
                  <Text style={[styles.modalText, { color: colors.text }]}>
                    {selectedTask.description}
                  </Text>
                </View>
              )}

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

              {selectedTask.priority && (
                <View style={styles.modalSection}>
                  <Text style={[styles.modalLabel, { color: colors.muted }]}>Priority</Text>
                  <View style={styles.modalRow}>
                    {(() => {
                      const priorityConfig = getPriorityConfig(selectedTask.priority);
                      return priorityConfig ? (
                        <View style={[styles.statusBadge, { backgroundColor: priorityConfig.bgColor }]}>
                          <Text style={[styles.statusText, { color: priorityConfig.color }]}>
                            {priorityConfig.label}
                          </Text>
                        </View>
                      ) : null;
                    })()}
                  </View>
                </View>
              )}

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

              {selectedTask.createdAt && (
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
              )}
            </ScrollView>
          )}

          {selectedTask && isEditing && (
            <ScrollView style={styles.modalContent} showsVerticalScrollIndicator={false}>
              {/* Title */}
              <View style={styles.modalSection}>
                <Text style={[styles.modalLabel, { color: colors.muted }]}>Title</Text>
                <TextInput
                  style={[styles.editInput, { color: colors.text, borderColor: colors.divider }]}
                  value={editTaskTitle}
                  onChangeText={setEditTaskTitle}
                  placeholder="Task title..."
                  placeholderTextColor={colors.muted}
                />
              </View>

              {/* Description */}
              <View style={styles.modalSection}>
                <Text style={[styles.modalLabel, { color: colors.muted }]}>Description</Text>
                <TextInput
                  style={[styles.editInput, styles.editTextArea, { color: colors.text, borderColor: colors.divider }]}
                  value={editTaskDescription}
                  onChangeText={setEditTaskDescription}
                  placeholder="Add description..."
                  placeholderTextColor={colors.muted}
                  multiline
                  numberOfLines={4}
                  textAlignVertical="top"
                />
              </View>

              {/* Status */}
              <View style={[styles.modalSection, { zIndex: 30 }]}>
                <Text style={[styles.modalLabel, { color: colors.muted }]}>Status</Text>
                <TouchableOpacity
                  style={[styles.editSelectButton, { borderColor: colors.divider }]}
                  onPress={() => {
                    setShowEditStatusDropdown(!showEditStatusDropdown);
                    setShowEditPriorityDropdown(false);
                    setShowEditAssigneeDropdown(false);
                  }}
                >
                  <Text style={[styles.editSelectText, { color: colors.text }]}>
                    {getStatusConfig(editTaskStatus)?.label}
                  </Text>
                  <ChevronDown size={16} color={colors.muted} strokeWidth={1.5} />
                </TouchableOpacity>
                {showEditStatusDropdown && (
                  <View style={[styles.editDropdown, { backgroundColor: colors.background, borderColor: colors.divider }]}>
                    {(['todo', 'in_progress', 'review', 'done'] as const).map((status) => (
                      <TouchableOpacity
                        key={status}
                        style={[
                          styles.editDropdownItem,
                          editTaskStatus === status && { backgroundColor: '#F3F4F6' }
                        ]}
                        onPress={() => {
                          setEditTaskStatus(status);
                          setShowEditStatusDropdown(false);
                        }}
                      >
                        <Text style={[styles.editDropdownItemText, { color: colors.text }]}>
                          {getStatusConfig(status)?.label}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>

              {/* Priority */}
              <View style={[styles.modalSection, { zIndex: 20 }]}>
                <Text style={[styles.modalLabel, { color: colors.muted }]}>Priority</Text>
                <TouchableOpacity
                  style={[styles.editSelectButton, { borderColor: colors.divider }]}
                  onPress={() => {
                    setShowEditPriorityDropdown(!showEditPriorityDropdown);
                    setShowEditStatusDropdown(false);
                    setShowEditAssigneeDropdown(false);
                  }}
                >
                  <Text style={[styles.editSelectText, { color: colors.text }]}>
                    {getPriorityConfig(editTaskPriority)?.label}
                  </Text>
                  <ChevronDown size={16} color={colors.muted} strokeWidth={1.5} />
                </TouchableOpacity>
                {showEditPriorityDropdown && (
                  <View style={[styles.editDropdown, { backgroundColor: colors.background, borderColor: colors.divider }]}>
                    {(['low', 'medium', 'high', 'urgent'] as const).map((priority) => (
                      <TouchableOpacity
                        key={priority}
                        style={[
                          styles.editDropdownItem,
                          editTaskPriority === priority && { backgroundColor: '#F3F4F6' }
                        ]}
                        onPress={() => {
                          setEditTaskPriority(priority);
                          setShowEditPriorityDropdown(false);
                        }}
                      >
                        <Text style={[styles.editDropdownItemText, { color: colors.text }]}>
                          {getPriorityConfig(priority)?.label}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>

              {/* Assignee */}
              <View style={[styles.modalSection, { zIndex: 10 }]}>
                <Text style={[styles.modalLabel, { color: colors.muted }]}>Assignee</Text>
                <TouchableOpacity
                  style={[styles.editSelectButton, { borderColor: colors.divider }]}
                  onPress={() => {
                    setShowEditAssigneeDropdown(!showEditAssigneeDropdown);
                    setShowEditStatusDropdown(false);
                    setShowEditPriorityDropdown(false);
                  }}
                >
                  <Text style={[styles.editSelectText, { color: editTaskAssignee ? colors.text : colors.muted }]}>
                    {editTaskAssignee
                      ? members.find(m => m.userId === editTaskAssignee)?.name || members.find(m => m.userId === editTaskAssignee)?.email || 'Selected'
                      : 'Unassigned'}
                  </Text>
                  <ChevronDown size={16} color={colors.muted} strokeWidth={1.5} />
                </TouchableOpacity>
                {showEditAssigneeDropdown && (
                  <View style={[styles.editDropdown, { backgroundColor: colors.background, borderColor: colors.divider }]}>
                    <TouchableOpacity
                      style={styles.editDropdownItem}
                      onPress={() => {
                        setEditTaskAssignee(null);
                        setShowEditAssigneeDropdown(false);
                      }}
                    >
                      <Text style={[styles.editDropdownItemText, { color: colors.muted }]}>Unassigned</Text>
                    </TouchableOpacity>
                    {members.map((member) => (
                      <TouchableOpacity
                        key={member.id}
                        style={[
                          styles.editDropdownItem,
                          editTaskAssignee === member.userId && { backgroundColor: '#F3F4F6' }
                        ]}
                        onPress={() => {
                          setEditTaskAssignee(member.userId);
                          setShowEditAssigneeDropdown(false);
                        }}
                      >
                        <Text style={[styles.editDropdownItemText, { color: colors.text }]}>
                          {member.name || member.email || member.userId}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>

              {/* Action Buttons */}
              <View style={styles.editButtonsRow}>
                <TouchableOpacity
                  style={[styles.editCancelButton, { borderColor: colors.divider }]}
                  onPress={cancelEditing}
                  disabled={isSaving}
                >
                  <Text style={[styles.editCancelButtonText, { color: colors.text }]}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.editSaveButton,
                    { backgroundColor: editTaskTitle.trim() && !isSaving ? '#1F2937' : '#E5E7EB' }
                  ]}
                  onPress={handleSaveTask}
                  disabled={!editTaskTitle.trim() || isSaving}
                >
                  {isSaving ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <Text style={[styles.editSaveButtonText, { color: editTaskTitle.trim() ? '#FFFFFF' : '#9CA3AF' }]}>
                      Save
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            </ScrollView>
          )}
        </SafeAreaView>
      </Modal>

      {/* Create Task Modal */}
      <Modal
        visible={showCreateModal}
        animationType="none"
        transparent={true}
        onRequestClose={() => setIsCreateModalVisible(false)}
      >
        <Animated.View style={[styles.modalBackdrop, { opacity: fadeAnim }]}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setIsCreateModalVisible(false)}
          />
          <Animated.View
            style={[
              styles.createModalContainer,
              { backgroundColor: colors.background },
              { transform: [{ scale: fadeAnim.interpolate({ inputRange: [0, 1], outputRange: [0.95, 1] }) }] }
            ]}
          >
            <View style={styles.createModalHeader}>
              <Text style={[styles.createModalTitle, { color: colors.text }]}>Add task</Text>
              <TouchableOpacity
                onPress={() => setIsCreateModalVisible(false)}
                style={styles.createModalCloseButton}
              >
                <X size={20} color={colors.muted} strokeWidth={1.5} />
              </TouchableOpacity>
            </View>

          <ScrollView style={styles.createModalContent} showsVerticalScrollIndicator={false} contentContainerStyle={styles.createModalScrollContent}>
            {/* Title */}
            <View style={styles.formSection}>
              <Text style={[styles.formLabel, { color: colors.text }]}>Title</Text>
              <TextInput
                style={[styles.formInput, { color: colors.text, borderColor: colors.divider }]}
                placeholder="Task title..."
                placeholderTextColor={colors.muted}
                value={newTaskTitle}
                onChangeText={setNewTaskTitle}
              />
            </View>

            {/* Description */}
            <View style={styles.formSection}>
              <Text style={[styles.formLabel, { color: colors.text }]}>Description</Text>
              <TextInput
                style={[styles.formInput, styles.formTextArea, { color: colors.text, borderColor: colors.divider }]}
                placeholder="Add more details..."
                placeholderTextColor={colors.muted}
                value={newTaskDescription}
                onChangeText={setNewTaskDescription}
                multiline
                numberOfLines={4}
                textAlignVertical="top"
              />
            </View>

            {/* Status and Priority Row */}
            <View style={styles.formRow}>
              <View style={styles.formHalf}>
                <Text style={[styles.formLabel, { color: colors.text }]}>Status</Text>
                <TouchableOpacity
                  style={[styles.selectButton, { borderColor: colors.divider }]}
                  onPress={() => setShowStatusDropdown(!showStatusDropdown)}
                >
                  <Text style={[styles.selectButtonText, { color: colors.text }]}>
                    {getStatusConfig(newTaskStatus)?.label}
                  </Text>
                  <ChevronDown size={16} color={colors.muted} strokeWidth={1.5} />
                </TouchableOpacity>
                {showStatusDropdown && (
                  <View style={[styles.dropdown, { backgroundColor: colors.background, borderColor: colors.divider }]}>
                    {(['todo', 'in_progress', 'review', 'done'] as const).map((status) => (
                      <TouchableOpacity
                        key={status}
                        style={[
                          styles.dropdownItem,
                          newTaskStatus === status && { backgroundColor: '#F3F4F6' }
                        ]}
                        onPress={() => {
                          setNewTaskStatus(status);
                          setShowStatusDropdown(false);
                        }}
                      >
                        <Text style={[styles.dropdownItemText, { color: colors.text }]}>
                          {getStatusConfig(status)?.label}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>

              <View style={styles.formHalf}>
                <Text style={[styles.formLabel, { color: colors.text }]}>Priority</Text>
                <TouchableOpacity
                  style={[styles.selectButton, { borderColor: colors.divider }]}
                  onPress={() => setShowPriorityDropdown(!showPriorityDropdown)}
                >
                  <Text style={[styles.selectButtonText, { color: colors.text }]}>
                    {getPriorityConfig(newTaskPriority)?.label}
                  </Text>
                  <ChevronDown size={16} color={colors.muted} strokeWidth={1.5} />
                </TouchableOpacity>
                {showPriorityDropdown && (
                  <View style={[styles.dropdown, { backgroundColor: colors.background, borderColor: colors.divider }]}>
                    {(['low', 'medium', 'high', 'urgent'] as const).map((priority) => (
                      <TouchableOpacity
                        key={priority}
                        style={[
                          styles.dropdownItem,
                          newTaskPriority === priority && { backgroundColor: '#F3F4F6' }
                        ]}
                        onPress={() => {
                          setNewTaskPriority(priority);
                          setShowPriorityDropdown(false);
                        }}
                      >
                        <Text style={[styles.dropdownItemText, { color: colors.text }]}>
                          {getPriorityConfig(priority)?.label}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>
            </View>

            {/* Assignee and Due Date Row */}
            <View style={styles.formRow}>
              <View style={styles.formHalf}>
                <Text style={[styles.formLabel, { color: colors.text }]}>Assignee</Text>
                <TouchableOpacity
                  style={[styles.selectButton, { borderColor: colors.divider }]}
                  onPress={() => setShowAssigneeDropdown(!showAssigneeDropdown)}
                >
                  <Text style={[styles.selectButtonText, { color: selectedAssignee ? colors.text : colors.muted }]}>
                    {selectedAssignee
                      ? members.find(m => m.userId === selectedAssignee)?.name || members.find(m => m.userId === selectedAssignee)?.email || 'Selected'
                      : 'Select assignee...'}
                  </Text>
                  <ChevronDown size={16} color={colors.muted} strokeWidth={1.5} />
                </TouchableOpacity>
                {showAssigneeDropdown && (
                  <View style={[styles.dropdown, { backgroundColor: colors.background, borderColor: colors.divider }]}>
                    <TouchableOpacity
                      style={[styles.dropdownItem, { borderBottomColor: colors.divider }]}
                      onPress={() => {
                        setSelectedAssignee(null);
                        setShowAssigneeDropdown(false);
                      }}
                    >
                      <Text style={[styles.dropdownItemText, { color: colors.muted }]}>Unassigned</Text>
                    </TouchableOpacity>
                    {members.map((member) => (
                      <TouchableOpacity
                        key={member.id}
                        style={[
                          styles.dropdownItem,
                          { borderBottomColor: colors.divider },
                          selectedAssignee === member.userId && { backgroundColor: colors.divider }
                        ]}
                        onPress={() => {
                          setSelectedAssignee(member.userId);
                          setShowAssigneeDropdown(false);
                        }}
                      >
                        <Text style={[styles.dropdownItemText, { color: colors.text }]}>
                          {member.name || member.email || member.userId}
                        </Text>
                      </TouchableOpacity>
                    ))}
                    {members.length === 0 && (
                      <View style={styles.dropdownItem}>
                        <Text style={[styles.dropdownItemText, { color: colors.muted }]}>No members found</Text>
                      </View>
                    )}
                  </View>
                )}
              </View>

              <View style={styles.formHalf}>
                <Text style={[styles.formLabel, { color: colors.text }]}>Due Date</Text>
                <TouchableOpacity
                  style={[styles.selectButton, { borderColor: colors.divider }]}
                  onPress={() => setNewTaskDueDate(new Date())}
                >
                  <Calendar size={16} color={colors.muted} strokeWidth={1.5} />
                  <Text style={[styles.selectButtonText, { color: newTaskDueDate ? colors.text : colors.muted, flex: 1 }]}>
                    {newTaskDueDate ? formatDate(newTaskDueDate) : 'Pick a date'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Tags */}
            <View style={styles.formSection}>
              <Text style={[styles.formLabel, { color: colors.text }]}>Tags</Text>
              <View style={styles.tagsInputRow}>
                <TextInput
                  style={[styles.tagInput, { color: colors.text, borderColor: colors.divider }]}
                  placeholder="Add a tag..."
                  placeholderTextColor={colors.muted}
                  value={newTaskTag}
                  onChangeText={setNewTaskTag}
                  onSubmitEditing={handleAddTag}
                />
                <TouchableOpacity
                  style={[styles.tagAddButton, { borderColor: colors.divider }]}
                  onPress={handleAddTag}
                >
                  <Text style={[styles.tagAddButtonText, { color: colors.text }]}>Add</Text>
                </TouchableOpacity>
              </View>
              {newTaskTags.length > 0 && (
                <View style={styles.tagsContainer}>
                  {newTaskTags.map((tag) => (
                    <TouchableOpacity
                      key={tag}
                      style={[styles.tagBadge, { backgroundColor: '#F3F4F6' }]}
                      onPress={() => handleRemoveTag(tag)}
                    >
                      <Text style={styles.tagBadgeText}>{tag}</Text>
                      <X size={12} color="#6B7280" strokeWidth={2} />
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>

            {/* Footer */}
            <View style={styles.createModalFooter}>
              <TouchableOpacity
                style={[styles.cancelButton, { borderColor: colors.divider }]}
                onPress={() => setIsCreateModalVisible(false)}
                disabled={isCreating}
              >
                <Text style={[styles.cancelButtonText, { color: isCreating ? colors.muted : colors.text }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.addTaskButton,
                  { backgroundColor: newTaskTitle.trim() && !isCreating ? '#1F2937' : '#E5E7EB' }
                ]}
                onPress={handleCreateTask}
                disabled={!newTaskTitle.trim() || isCreating}
              >
                {isCreating ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text style={[
                    styles.addTaskButtonText,
                    { color: newTaskTitle.trim() ? '#FFFFFF' : '#9CA3AF' }
                  ]}>
                    Add task
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </ScrollView>
          </Animated.View>
        </Animated.View>
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
  // Create Modal Styles
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  createModalContainer: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    width: '100%',
    maxWidth: 500,
    maxHeight: '90%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  createModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
  },
  createModalTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  createModalCloseButton: {
    padding: 4,
  },
  createModalContent: {
  },
  createModalScrollContent: {
    paddingHorizontal: 20,
    paddingTop: 8,
    flexGrow: 0,
  },
  formSection: {
    marginBottom: 20,
  },
  formLabel: {
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 8,
  },
  formInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 14,
  },
  formTextArea: {
    minHeight: 100,
    paddingTop: 12,
  },
  formRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 20,
  },
  formHalf: {
    flex: 1,
    position: 'relative',
    zIndex: 1,
  },
  selectButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 8,
  },
  selectButtonText: {
    fontSize: 14,
  },
  dropdown: {
    position: 'absolute',
    top: 76,
    left: 0,
    right: 0,
    borderWidth: 1,
    borderRadius: 8,
    zIndex: 100,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  dropdownItem: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  dropdownItemText: {
    fontSize: 14,
  },
  tagsInputRow: {
    flexDirection: 'row',
    gap: 8,
  },
  tagInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 14,
  },
  tagAddButton: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  tagAddButtonText: {
    fontSize: 14,
    fontWeight: '500',
  },
  tagsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
  },
  tagBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  tagBadgeText: {
    fontSize: 13,
    color: '#374151',
  },
  createModalFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    paddingTop: 8,
    paddingBottom: 20,
  },
  cancelButton: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  cancelButtonText: {
    fontSize: 14,
    fontWeight: '500',
  },
  addTaskButton: {
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  addTaskButtonText: {
    fontSize: 14,
    fontWeight: '500',
  },
  // Edit modal styles
  modalHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerIconButton: {
    padding: 8,
  },
  editInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 15,
  },
  editTextArea: {
    minHeight: 100,
    paddingTop: 12,
  },
  editSelectButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  editSelectText: {
    fontSize: 15,
  },
  editDropdown: {
    position: 'absolute',
    top: 70,
    left: 0,
    right: 0,
    borderWidth: 1,
    borderRadius: 8,
    zIndex: 100,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  editDropdownItem: {
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  editDropdownItemText: {
    fontSize: 15,
  },
  editButtonsRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 24,
    marginBottom: 40,
  },
  editCancelButton: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  editCancelButtonText: {
    fontSize: 15,
    fontWeight: '500',
  },
  editSaveButton: {
    borderRadius: 8,
    paddingHorizontal: 24,
    paddingVertical: 12,
    minWidth: 80,
    alignItems: 'center',
  },
  editSaveButtonText: {
    fontSize: 15,
    fontWeight: '500',
  },
});
