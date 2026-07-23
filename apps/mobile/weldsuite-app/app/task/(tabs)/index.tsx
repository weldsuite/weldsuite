import React, { useEffect } from 'react';
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
  CheckSquare,
  Clock,
  AlertCircle,
  Star,
  Plus,
  ChevronRight,
  Zap,
  Calendar,
} from 'lucide-react-native';
import { useCollapsibleHeader } from '@/contexts/CollapsibleHeaderContext';

// Responsive breakpoint
const TABLET_MIN_WIDTH = 768;

export default function TaskDashboard() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { width: windowWidth } = useWindowDimensions();
  const { onScroll: onCollapsibleScroll, resetHeader } = useCollapsibleHeader();
  const {
    dashboardData,
    taskStats,
    loading,
    errors,
    loadDashboard,
    refreshDashboard,
    loadWorkflowStats,
    workflowStats,
  } = useTask();

  const isTablet = windowWidth >= TABLET_MIN_WIDTH;
  const [refreshing, setRefreshing] = React.useState(false);

  // Reset header when tab becomes active
  useEffect(() => {
    resetHeader();
  }, [resetHeader]);

  useEffect(() => {
    loadDashboard();
    loadWorkflowStats();
  }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await refreshDashboard();
    await loadWorkflowStats();
    setRefreshing(false);
  };

  const stats = taskStats || dashboardData?.stats || {
    total: 0,
    todo: 0,
    inProgress: 0,
    completed: 0,
    overdue: 0,
    dueToday: 0,
    dueThisWeek: 0,
  };

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={[
        styles.contentContainer,
        {
          paddingBottom: insets.bottom + 100,
          paddingHorizontal: isTablet ? 24 : 16,
        }
      ]}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#8B5CF6" />
      }
      onScroll={!isTablet ? onCollapsibleScroll : undefined}
      scrollEventThrottle={16}
    >
      {/* Stats Grid - 4 cols on tablet, 2 on phone */}
      <View style={[styles.statsGrid, isTablet && styles.statsGridTablet]}>
        <View style={[
          styles.statCard,
          { backgroundColor: '#EEF2FF' },
          isTablet && styles.statCardTablet,
        ]}>
          <View style={[styles.statIcon, { backgroundColor: '#8B5CF6' }]}>
            <CheckSquare size={20} color="#FFFFFF" strokeWidth={2} />
          </View>
          <Text style={styles.statValue}>{stats.total}</Text>
          <Text style={[styles.statLabel, { color: colors.muted }]}>Total Tasks</Text>
        </View>

        <View style={[
          styles.statCard,
          { backgroundColor: '#FEF3C7' },
          isTablet && styles.statCardTablet,
        ]}>
          <View style={[styles.statIcon, { backgroundColor: '#F59E0B' }]}>
            <Clock size={20} color="#FFFFFF" strokeWidth={2} />
          </View>
          <Text style={styles.statValue}>{stats.inProgress}</Text>
          <Text style={[styles.statLabel, { color: colors.muted }]}>In Progress</Text>
        </View>

        <View style={[
          styles.statCard,
          { backgroundColor: '#DCFCE7' },
          isTablet && styles.statCardTablet,
        ]}>
          <View style={[styles.statIcon, { backgroundColor: '#22C55E' }]}>
            <CheckSquare size={20} color="#FFFFFF" strokeWidth={2} />
          </View>
          <Text style={styles.statValue}>{stats.completed}</Text>
          <Text style={[styles.statLabel, { color: colors.muted }]}>Completed</Text>
        </View>

        <View style={[
          styles.statCard,
          { backgroundColor: '#FEE2E2' },
          isTablet && styles.statCardTablet,
        ]}>
          <View style={[styles.statIcon, { backgroundColor: '#EF4444' }]}>
            <AlertCircle size={20} color="#FFFFFF" strokeWidth={2} />
          </View>
          <Text style={styles.statValue}>{stats.overdue}</Text>
          <Text style={[styles.statLabel, { color: colors.muted }]}>Overdue</Text>
        </View>
      </View>

      {/* Quick Actions */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>Quick Actions</Text>
        <View style={styles.quickActions}>
          <TouchableOpacity
            style={[styles.quickAction, { backgroundColor: '#8B5CF6' }]}
            onPress={() => router.push('/task/create')}
          >
            <Plus size={20} color="#FFFFFF" strokeWidth={2} />
            <Text style={styles.quickActionText}>New Task</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.quickAction, { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border }]}
            onPress={() => router.push('/task/workflows')}
          >
            <Zap size={20} color="#8B5CF6" strokeWidth={2} />
            <Text style={[styles.quickActionText, { color: colors.text }]}>Workflows</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Main content area - side by side on tablet */}
      <View style={[styles.mainContent, isTablet && styles.mainContentTablet]}>
        {/* Due Today */}
        <View style={[styles.section, isTablet && styles.sectionTablet]}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionTitleRow}>
              <Calendar size={18} color="#8B5CF6" strokeWidth={2} />
              <Text style={[styles.sectionTitle, { color: colors.text }]}>Due Today</Text>
            </View>
            <Text style={[styles.sectionCount, { color: colors.muted }]}>{stats.dueToday} tasks</Text>
          </View>

          {dashboardData?.upcomingTasks?.slice(0, 3).map((task) => (
            <TouchableOpacity
              key={task.id}
              style={[styles.taskItem, { backgroundColor: colors.background, borderColor: colors.border }]}
              onPress={() => router.push(`/task/task/${task.id}`)}
            >
              <View style={styles.taskCheckbox}>
                <View style={[styles.checkbox, { borderColor: getPriorityColor(task.priority) }]} />
              </View>
              <View style={styles.taskContent}>
                <Text style={[styles.taskTitle, { color: colors.text }]} numberOfLines={1}>
                  {task.title}
                </Text>
                {task.projectName && (
                  <Text style={[styles.taskProject, { color: colors.muted }]}>{task.projectName}</Text>
                )}
              </View>
              {task.isImportant && <Star size={16} color="#F59E0B" fill="#F59E0B" />}
              <ChevronRight size={16} color={colors.muted} />
            </TouchableOpacity>
          )) || (
            <View style={[styles.emptyState, { borderColor: colors.border }]}>
              <Text style={[styles.emptyText, { color: colors.muted }]}>No tasks due today</Text>
            </View>
          )}
        </View>

        {/* Important Tasks */}
        <View style={[styles.section, isTablet && styles.sectionTablet]}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionTitleRow}>
              <Star size={18} color="#F59E0B" strokeWidth={2} />
              <Text style={[styles.sectionTitle, { color: colors.text }]}>Important</Text>
            </View>
            <TouchableOpacity onPress={() => router.push('/task/(tabs)/important')}>
              <Text style={styles.seeAll}>See All</Text>
            </TouchableOpacity>
          </View>

          {dashboardData?.importantTasks?.slice(0, 3).map((task) => (
            <TouchableOpacity
              key={task.id}
              style={[styles.taskItem, { backgroundColor: colors.background, borderColor: colors.border }]}
              onPress={() => router.push(`/task/task/${task.id}`)}
            >
              <View style={styles.taskCheckbox}>
                <View style={[styles.checkbox, { borderColor: getPriorityColor(task.priority) }]} />
              </View>
              <View style={styles.taskContent}>
                <Text style={[styles.taskTitle, { color: colors.text }]} numberOfLines={1}>
                  {task.title}
                </Text>
                {task.dueDate && (
                  <Text style={[styles.taskDue, { color: colors.muted }]}>
                    Due {formatDate(task.dueDate)}
                  </Text>
                )}
              </View>
              <ChevronRight size={16} color={colors.muted} />
            </TouchableOpacity>
          )) || (
            <View style={[styles.emptyState, { borderColor: colors.border }]}>
              <Text style={[styles.emptyText, { color: colors.muted }]}>No important tasks</Text>
            </View>
          )}
        </View>
      </View>

      {/* Workflows Overview */}
      {workflowStats && (
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View style={styles.sectionTitleRow}>
              <Zap size={18} color="#8B5CF6" strokeWidth={2} />
              <Text style={[styles.sectionTitle, { color: colors.text }]}>Workflows</Text>
            </View>
            <TouchableOpacity onPress={() => router.push('/task/workflows')}>
              <Text style={styles.seeAll}>Manage</Text>
            </TouchableOpacity>
          </View>

          <View style={[styles.workflowStats, isTablet && styles.workflowStatsTablet]}>
            <View style={[styles.workflowStat, { borderColor: colors.border }]}>
              <Text style={[styles.workflowStatValue, { color: colors.text }]}>
                {workflowStats.activeWorkflows}
              </Text>
              <Text style={[styles.workflowStatLabel, { color: colors.muted }]}>Active</Text>
            </View>
            <View style={[styles.workflowStat, { borderColor: colors.border }]}>
              <Text style={[styles.workflowStatValue, { color: colors.text }]}>
                {workflowStats.executionsToday}
              </Text>
              <Text style={[styles.workflowStatLabel, { color: colors.muted }]}>Today</Text>
            </View>
            <View style={[styles.workflowStat, { borderColor: colors.border }]}>
              <Text style={[styles.workflowStatValue, { color: '#22C55E' }]}>
                {Math.round(workflowStats.successRate * 100)}%
              </Text>
              <Text style={[styles.workflowStatLabel, { color: colors.muted }]}>Success</Text>
            </View>
          </View>
        </View>
      )}
    </ScrollView>
  );
}

function getPriorityColor(priority: string): string {
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
  contentContainer: {
    paddingVertical: 16,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 24,
  },
  statsGridTablet: {
    flexWrap: 'nowrap',
  },
  statCard: {
    flex: 1,
    minWidth: '45%',
    padding: 16,
    borderRadius: 12,
  },
  statCardTablet: {
    minWidth: 0,
  },
  statIcon: {
    width: 36,
    height: 36,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  statValue: {
    fontSize: 28,
    fontWeight: '700',
    color: '#111827',
  },
  statLabel: {
    fontSize: 12,
    marginTop: 4,
  },
  section: {
    marginBottom: 24,
  },
  sectionTablet: {
    flex: 1,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  sectionCount: {
    fontSize: 14,
  },
  seeAll: {
    fontSize: 14,
    color: '#8B5CF6',
    fontWeight: '500',
  },
  mainContent: {
    // Default: stacked
  },
  mainContentTablet: {
    flexDirection: 'row',
    gap: 24,
  },
  quickActions: {
    flexDirection: 'row',
    gap: 12,
  },
  quickAction: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: 10,
  },
  quickActionText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
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
  taskCheckbox: {
    width: 24,
    height: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 2,
  },
  taskContent: {
    flex: 1,
  },
  taskTitle: {
    fontSize: 15,
    fontWeight: '500',
  },
  taskProject: {
    fontSize: 12,
    marginTop: 2,
  },
  taskDue: {
    fontSize: 12,
    marginTop: 2,
  },
  emptyState: {
    padding: 24,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: 'dashed',
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 14,
  },
  workflowStats: {
    flexDirection: 'row',
    gap: 12,
  },
  workflowStatsTablet: {
    maxWidth: 400,
  },
  workflowStat: {
    flex: 1,
    padding: 16,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
  },
  workflowStatValue: {
    fontSize: 24,
    fontWeight: '700',
  },
  workflowStatLabel: {
    fontSize: 12,
    marginTop: 4,
  },
});
