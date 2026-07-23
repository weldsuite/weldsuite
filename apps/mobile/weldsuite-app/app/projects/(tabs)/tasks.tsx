import React, { useState, useEffect, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  TextInput,
} from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  CheckSquare,
  Clock,
  AlertCircle,
  Search,
  Filter,
  CircleDot,
  Circle,
  CheckCircle2,
  XCircle,
  Pause,
} from 'lucide-react-native';
import api, { ProjectTaskWithProject, ProjectTaskStats } from '@/services/api';

const STATUS_OPTIONS = [
  { label: 'All', value: '' },
  { label: 'To Do', value: 'todo' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'In Review', value: 'review' },
  { label: 'Done', value: 'done' },
  { label: 'Blocked', value: 'blocked' },
];

export default function TasksScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const [tasks, setTasks] = useState<ProjectTaskWithProject[]>([]);
  const [stats, setStats] = useState<ProjectTaskStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    loadData();
  }, [selectedStatus]);

  const loadData = async () => {
    try {
      setLoading(true);
      await Promise.all([loadStats(), loadTasks()]);
    } catch (error) {
      console.error('Error loading tasks data:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const loadStats = async () => {
    try {
      const response = await api.getProjectTaskStats();
      if (response.success && response.data) {
        setStats(response.data);
      }
    } catch (error) {
      console.error('Error loading task stats:', error);
    }
  };

  const loadTasks = async () => {
    try {
      const response = await api.getAllProjectTasks({
        limit: 50,
        status: selectedStatus || undefined,
        search: searchQuery || undefined,
      });
      if (response.success && response.data) {
        setTasks(response.data.items);
      }
    } catch (error) {
      console.error('Error loading tasks:', error);
      toast.error('Failed to load tasks');
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadData();
  };

  const handleSearch = useCallback(() => {
    loadTasks();
  }, [searchQuery, selectedStatus]);

  const getStatusIcon = (status: string) => {
    switch (status.toLowerCase()) {
      case 'todo':
        return <Circle size={16} color={colors.muted} strokeWidth={2} />;
      case 'in_progress':
        return <CircleDot size={16} color="#3B82F6" strokeWidth={2} />;
      case 'review':
        return <Clock size={16} color="#F59E0B" strokeWidth={2} />;
      case 'done':
        return <CheckCircle2 size={16} color="#10B981" strokeWidth={2} />;
      case 'blocked':
        return <XCircle size={16} color="#EF4444" strokeWidth={2} />;
      default:
        return <Circle size={16} color={colors.muted} strokeWidth={2} />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case 'todo':
        return colors.muted;
      case 'in_progress':
        return '#3B82F6';
      case 'review':
        return '#F59E0B';
      case 'done':
        return '#10B981';
      case 'blocked':
        return '#EF4444';
      default:
        return colors.muted;
    }
  };

  const getPriorityColor = (priority: string) => {
    switch (priority.toLowerCase()) {
      case 'high':
      case 'urgent':
        return '#EF4444';
      case 'medium':
        return '#F59E0B';
      case 'low':
        return '#10B981';
      default:
        return colors.muted;
    }
  };

  const formatDate = (dateString?: string) => {
    if (!dateString) return null;
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
  };

  const isOverdue = (dueDate?: string) => {
    if (!dueDate) return false;
    return new Date(dueDate) < new Date();
  };

  if (loading && !refreshing) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>
          Loading tasks...
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top + 45 }]}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
      }
    >
      {/* Stats Overview */}
      {stats && (
        <View style={styles.statsContainer}>
          <View style={[styles.statCard, { backgroundColor: colors.background, borderColor: colors.divider }]}>
            <View style={[styles.statIcon, { backgroundColor: '#3B82F620' }]}>
              <CheckSquare size={18} color="#3B82F6" strokeWidth={2} />
            </View>
            <Text style={[styles.statValue, { color: colors.text }]}>{stats.totalTasks}</Text>
            <Text style={[styles.statLabel, { color: colors.muted }]}>Total</Text>
          </View>
          <View style={[styles.statCard, { backgroundColor: colors.background, borderColor: colors.divider }]}>
            <View style={[styles.statIcon, { backgroundColor: '#F59E0B20' }]}>
              <Clock size={18} color="#F59E0B" strokeWidth={2} />
            </View>
            <Text style={[styles.statValue, { color: colors.text }]}>{stats.inProgressTasks}</Text>
            <Text style={[styles.statLabel, { color: colors.muted }]}>In Progress</Text>
          </View>
          <View style={[styles.statCard, { backgroundColor: colors.background, borderColor: colors.divider }]}>
            <View style={[styles.statIcon, { backgroundColor: '#10B98120' }]}>
              <CheckCircle2 size={18} color="#10B981" strokeWidth={2} />
            </View>
            <Text style={[styles.statValue, { color: colors.text }]}>{stats.doneTasks}</Text>
            <Text style={[styles.statLabel, { color: colors.muted }]}>Done</Text>
          </View>
          <View style={[styles.statCard, { backgroundColor: colors.background, borderColor: colors.divider }]}>
            <View style={[styles.statIcon, { backgroundColor: '#EF444420' }]}>
              <AlertCircle size={18} color="#EF4444" strokeWidth={2} />
            </View>
            <Text style={[styles.statValue, { color: colors.text }]}>{stats.overdueTasks}</Text>
            <Text style={[styles.statLabel, { color: colors.muted }]}>Overdue</Text>
          </View>
        </View>
      )}

      {/* Search and Filter */}
      <View style={styles.searchSection}>
        <View style={[styles.searchContainer, { backgroundColor: colors.background, borderColor: colors.divider }]}>
          <Search size={18} color={colors.muted} strokeWidth={2} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search tasks..."
            placeholderTextColor={colors.muted}
            value={searchQuery}
            onChangeText={setSearchQuery}
            onSubmitEditing={handleSearch}
            returnKeyType="search"
          />
        </View>
        <TouchableOpacity
          style={[styles.filterButton, { backgroundColor: showFilters ? '#3B82F620' : colors.background, borderColor: colors.divider }]}
          onPress={() => setShowFilters(!showFilters)}
        >
          <Filter size={18} color={showFilters ? '#3B82F6' : colors.muted} strokeWidth={2} />
        </TouchableOpacity>
      </View>

      {/* Filter Pills */}
      {showFilters && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.filterPillsContainer}
          contentContainerStyle={styles.filterPills}
        >
          {STATUS_OPTIONS.map((option) => (
            <TouchableOpacity
              key={option.value}
              style={[
                styles.filterPill,
                {
                  backgroundColor: selectedStatus === option.value ? '#3B82F6' : colors.background,
                  borderColor: selectedStatus === option.value ? '#3B82F6' : colors.divider,
                },
              ]}
              onPress={() => setSelectedStatus(option.value)}
            >
              <Text
                style={[
                  styles.filterPillText,
                  { color: selectedStatus === option.value ? '#FFFFFF' : colors.text },
                ]}
              >
                {option.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* Tasks List */}
      <View style={styles.tasksList}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>
          Tasks {tasks.length > 0 && `(${tasks.length})`}
        </Text>
        {tasks.length === 0 ? (
          <View style={styles.emptyState}>
            <CheckSquare size={48} color={colors.muted} strokeWidth={1.5} />
            <Text style={[styles.emptyTitle, { color: colors.text }]}>No tasks found</Text>
            <Text style={[styles.emptyText, { color: colors.muted }]}>
              {selectedStatus ? 'Try a different filter' : 'Tasks will appear here'}
            </Text>
          </View>
        ) : (
          tasks.map((task) => (
            <TouchableOpacity
              key={task.id}
              style={[styles.taskCard, { backgroundColor: colors.background, borderColor: colors.divider }]}
              activeOpacity={0.7}
            >
              <View style={styles.taskHeader}>
                <View style={styles.taskTitleRow}>
                  {getStatusIcon(task.status)}
                  <Text style={[styles.taskTitle, { color: colors.text }]} numberOfLines={1}>
                    {task.title}
                  </Text>
                </View>
                <View
                  style={[styles.priorityBadge, { backgroundColor: getPriorityColor(task.priority) + '20' }]}
                >
                  <Text style={[styles.priorityText, { color: getPriorityColor(task.priority) }]}>
                    {task.priority}
                  </Text>
                </View>
              </View>

              {task.description && (
                <Text style={[styles.taskDescription, { color: colors.muted }]} numberOfLines={2}>
                  {task.description}
                </Text>
              )}

              <View style={styles.taskFooter}>
                <View style={[styles.projectBadge, { backgroundColor: task.project.color + '20' }]}>
                  <View style={[styles.projectDot, { backgroundColor: task.project.color }]} />
                  <Text style={[styles.projectName, { color: task.project.color }]} numberOfLines={1}>
                    {task.project.name}
                  </Text>
                </View>
                {task.dueDate && (
                  <View style={styles.dueDateContainer}>
                    <Clock size={12} color={isOverdue(task.dueDate) ? '#EF4444' : colors.muted} strokeWidth={2} />
                    <Text
                      style={[
                        styles.dueDate,
                        { color: isOverdue(task.dueDate) ? '#EF4444' : colors.muted },
                      ]}
                    >
                      {formatDate(task.dueDate)}
                    </Text>
                  </View>
                )}
              </View>
            </TouchableOpacity>
          ))
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 16,
    fontSize: 12,
  },
  statsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    padding: 16,
    gap: 12,
  },
  statCard: {
    width: '47%',
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  statIcon: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  statValue: {
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 2,
  },
  statLabel: {
    fontSize: 11,
  },
  searchSection: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    gap: 12,
    marginBottom: 12,
  },
  searchContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    height: 44,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    height: '100%',
  },
  filterButton: {
    width: 44,
    height: 44,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterPillsContainer: {
    marginBottom: 12,
  },
  filterPills: {
    paddingHorizontal: 16,
    gap: 8,
  },
  filterPill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    marginRight: 8,
  },
  filterPillText: {
    fontSize: 13,
    fontWeight: '500',
  },
  tasksList: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 16,
  },
  taskCard: {
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 10,
  },
  taskHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  taskTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 8,
  },
  taskTitle: {
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
  },
  priorityBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    marginLeft: 8,
  },
  priorityText: {
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  taskDescription: {
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 10,
  },
  taskFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  projectBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    gap: 6,
    maxWidth: '60%',
  },
  projectDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  projectName: {
    fontSize: 11,
    fontWeight: '500',
  },
  dueDateContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  dueDate: {
    fontSize: 11,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 48,
    paddingHorizontal: 32,
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
});
