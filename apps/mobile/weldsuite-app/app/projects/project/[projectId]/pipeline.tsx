import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Modal,
  TextInput,
  Animated,
} from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { useLocalSearchParams } from 'expo-router';
import { Plus, X } from 'lucide-react-native';
import api from '@/services/api';

interface Task {
  id: string;
  title: string;
  status: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  assignee?: {
    id: string;
    name: string;
  };
}

interface Column {
  id: string;
  title: string;
  color: string;
  tasks: Task[];
}

const priorityConfig = {
  low: { color: '#6B7280' },
  medium: { color: '#3B82F6' },
  high: { color: '#F59E0B' },
  urgent: { color: '#EF4444' },
};

const columnConfig = [
  { id: 'todo', title: 'To Do', color: '#6B7280' },
  { id: 'in_progress', title: 'In Progress', color: '#3B82F6' },
  { id: 'review', title: 'Review', color: '#8B5CF6' },
  { id: 'done', title: 'Done', color: '#10B981' },
];

export default function ProjectPipelineScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const { projectId } = useLocalSearchParams();
  const [columns, setColumns] = useState<Column[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Create task modal state
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('todo');
  const [isCreating, setIsCreating] = useState(false);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    loadPipeline();
  }, [projectId]);

  useEffect(() => {
    if (isModalVisible) {
      setShowModal(true);
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
      }).start(() => setShowModal(false));
    }
  }, [isModalVisible]);

  const loadPipeline = async () => {
    try {
      setLoading(true);

      const response = await api.getProjectTasks(projectId as string, { limit: 100 });

      if (response.success && response.data) {
        const tasks = response.data.items || [];

        // Group tasks by status into columns
        const groupedColumns: Column[] = columnConfig.map(col => ({
          ...col,
          tasks: tasks
            .filter((task: any) => task.status === col.id)
            .map((task: any) => ({
              id: task.id,
              title: task.title,
              status: task.status,
              priority: task.priority || 'medium',
              assignee: task.assignee,
            })),
        }));

        setColumns(groupedColumns);
      }
    } catch (error) {
      console.error('Error loading pipeline:', error);
      toast.error('Failed to load pipeline');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadPipeline();
  };

  const handleAddTask = (status: string) => {
    setSelectedStatus(status);
    setNewTaskTitle('');
    setIsModalVisible(true);
  };

  const handleCreateTask = async () => {
    if (!newTaskTitle.trim() || isCreating) return;

    setIsCreating(true);
    try {
      const response = await api.createProjectTask(projectId as string, {
        title: newTaskTitle.trim(),
        status: selectedStatus,
        priority: 'medium',
      });

      if (response.success && response.data) {
        // Add the new task to the appropriate column
        setColumns(prevColumns =>
          prevColumns.map(col =>
            col.id === selectedStatus
              ? {
                  ...col,
                  tasks: [
                    ...col.tasks,
                    {
                      id: response.data.id,
                      title: response.data.title,
                      status: response.data.status,
                      priority: response.data.priority || 'medium',
                      assignee: response.data.assignee,
                    },
                  ],
                }
              : col
          )
        );
        toast.success('Task created');
        setIsModalVisible(false);
        setNewTaskTitle('');
      }
    } catch (error) {
      console.error('Error creating task:', error);
      toast.error('Failed to create task');
    } finally {
      setIsCreating(false);
    }
  };

  if (loading && !refreshing) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
      </View>
    );
  }

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      horizontal
      showsHorizontalScrollIndicator={false}
      bounces={false}
      directionalLockEnabled={true}
      contentContainerStyle={styles.columnsContainer}
    >
      {columns.map((column) => (
        <View key={column.id} style={styles.column}>
          {/* Column Header */}
          <View style={styles.columnHeader}>
            <View style={[styles.columnDot, { backgroundColor: column.color }]} />
            <Text style={[styles.columnTitle, { color: colors.text }]}>
              {column.title}
            </Text>
            <View style={styles.columnCountBadge}>
              <Text style={[styles.columnCount, { color: colors.muted }]}>
                {column.tasks.length}
              </Text>
            </View>
          </View>

          {/* Tasks */}
          <ScrollView
            style={styles.columnContent}
            showsVerticalScrollIndicator={false}
            nestedScrollEnabled={true}
            bounces={false}
          >
            {column.tasks.map((task) => {
              const priority = priorityConfig[task.priority] || priorityConfig.medium;

              return (
                <TouchableOpacity
                  key={task.id}
                  style={[
                    styles.taskCard,
                    { backgroundColor: colors.card, borderColor: colors.divider },
                  ]}
                  activeOpacity={0.7}
                >
                  <View style={styles.taskHeader}>
                    <View style={[styles.priorityBar, { backgroundColor: priority.color }]} />
                    <Text style={[styles.taskTitle, { color: colors.text }]} numberOfLines={2}>
                      {task.title}
                    </Text>
                  </View>
                  {task.assignee?.name && (
                    <View style={styles.taskFooter}>
                      <View style={styles.avatar}>
                        <Text style={styles.avatarText}>
                          {task.assignee.name[0]}
                        </Text>
                      </View>
                      <Text style={[styles.assigneeName, { color: colors.muted }]}>
                        {task.assignee.name}
                      </Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}

            {/* Add Task Button */}
            <TouchableOpacity
              style={[styles.addTaskButton, { borderColor: colors.divider }]}
              onPress={() => handleAddTask(column.id)}
            >
              <Plus size={18} color={colors.muted} strokeWidth={2} />
              <Text style={[styles.addTaskText, { color: colors.muted }]}>
                Add task
              </Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      ))}

      {/* Create Task Modal */}
      <Modal
        visible={showModal}
        animationType="none"
        transparent={true}
        onRequestClose={() => setIsModalVisible(false)}
      >
        <Animated.View style={[styles.modalBackdrop, { opacity: fadeAnim }]}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setIsModalVisible(false)}
          />
          <Animated.View
            style={[
              styles.modalContainer,
              { backgroundColor: colors.background },
              { transform: [{ scale: fadeAnim.interpolate({ inputRange: [0, 1], outputRange: [0.95, 1] }) }] }
            ]}
          >
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.text }]}>
                Add task to {columnConfig.find(c => c.id === selectedStatus)?.title}
              </Text>
              <TouchableOpacity
                onPress={() => setIsModalVisible(false)}
                style={styles.modalCloseButton}
              >
                <X size={20} color={colors.muted} strokeWidth={1.5} />
              </TouchableOpacity>
            </View>

            <View style={styles.modalContent}>
              <TextInput
                style={[styles.taskInput, { color: colors.text, borderColor: colors.divider }]}
                placeholder="Task title..."
                placeholderTextColor={colors.muted}
                value={newTaskTitle}
                onChangeText={setNewTaskTitle}
                autoFocus
                onSubmitEditing={handleCreateTask}
                returnKeyType="done"
              />
            </View>

            <View style={styles.modalFooter}>
              <TouchableOpacity
                style={[styles.cancelButton, { borderColor: colors.divider }]}
                onPress={() => setIsModalVisible(false)}
                disabled={isCreating}
              >
                <Text style={[styles.cancelButtonText, { color: colors.text }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.createButton,
                  { backgroundColor: newTaskTitle.trim() && !isCreating ? '#1F2937' : '#E5E7EB' }
                ]}
                onPress={handleCreateTask}
                disabled={!newTaskTitle.trim() || isCreating}
              >
                {isCreating ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text style={[
                    styles.createButtonText,
                    { color: newTaskTitle.trim() ? '#FFFFFF' : '#9CA3AF' }
                  ]}>
                    Add task
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </Animated.View>
        </Animated.View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  columnsContainer: {
    flexDirection: 'row',
    paddingVertical: 12,
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  column: {
    width: 280,
    paddingHorizontal: 12,
    height: '100%',
  },
  columnHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  columnDot: {
    width: 10,
    height: 10,
    borderRadius: 4,
  },
  columnTitle: {
    fontSize: 14,
    fontWeight: '600',
    flex: 1,
  },
  columnCountBadge: {
    backgroundColor: '#F3F4F6',
    width: 18,
    height: 18,
    borderRadius: 4,
    justifyContent: 'center',
    alignItems: 'center',
  },
  columnCount: {
    fontSize: 10,
    fontWeight: '500',
  },
  columnContent: {
    flex: 1,
  },
  taskCard: {
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 8,
  },
  taskHeader: {
    flexDirection: 'row',
    gap: 10,
  },
  priorityBar: {
    width: 3,
    borderRadius: 2,
    minHeight: 20,
  },
  taskTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
    lineHeight: 20,
  },
  taskFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
    paddingLeft: 13,
  },
  avatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#E5E7EB',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#6B7280',
  },
  assigneeName: {
    fontSize: 12,
  },
  addTaskButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: 8,
  },
  addTaskText: {
    fontSize: 13,
    fontWeight: '500',
  },
  // Modal styles
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContainer: {
    borderRadius: 12,
    width: '100%',
    maxWidth: 400,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 16,
    paddingHorizontal: 20,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  modalCloseButton: {
    padding: 4,
  },
  modalContent: {
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  taskInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 15,
  },
  modalFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    paddingHorizontal: 20,
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
  createButton: {
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    minWidth: 80,
    alignItems: 'center',
  },
  createButtonText: {
    fontSize: 14,
    fontWeight: '500',
  },
});
