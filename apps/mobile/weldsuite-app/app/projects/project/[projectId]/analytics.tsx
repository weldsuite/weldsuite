import React, { useState, useCallback, useEffect } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { api } from '@/services/api';
import {
  BarChart3,
  TrendingUp,
  CheckCircle2,
  Clock,
  Users,
  Target,
  AlertCircle,
  Calendar,
} from 'lucide-react-native';

// Light mode colors - consistent with other pages
const colors = {
  background: '#FFFFFF',
  card: '#FFFFFF',
  text: '#18181B',
  muted: '#71717A',
  border: '#E4E4E7',
  subtle: '#F4F4F5',
  primary: '#3B82F6',
  success: '#10B981',
  warning: '#F59E0B',
  danger: '#EF4444',
};

interface ProjectAnalytics {
  totalTasks: number;
  completedTasks: number;
  inProgressTasks: number;
  overdueTasks: number;
  totalMembers: number;
  totalGoals: number;
  completedGoals: number;
  totalTimeLogged: number;
  tasksCompletedThisWeek: number;
  tasksTrend: number; // percentage change
}

export default function ProjectAnalyticsScreen() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();

  // State
  const [analytics, setAnalytics] = useState<ProjectAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Load analytics data
  const loadAnalytics = useCallback(async () => {
    if (!projectId) return;
    try {
      // For now, use mock data - replace with actual API call when available
      // const response = await api.getProjectAnalytics(projectId);
      const mockData: ProjectAnalytics = {
        totalTasks: 48,
        completedTasks: 32,
        inProgressTasks: 12,
        overdueTasks: 4,
        totalMembers: 8,
        totalGoals: 6,
        completedGoals: 2,
        totalTimeLogged: 156,
        tasksCompletedThisWeek: 8,
        tasksTrend: 15,
      };
      setAnalytics(mockData);
    } catch (error) {
      console.error('Failed to load analytics:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadAnalytics();
  }, [loadAnalytics]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadAnalytics();
  }, [loadAnalytics]);

  // Calculate completion percentage
  const completionPercentage = analytics
    ? Math.round((analytics.completedTasks / analytics.totalTasks) * 100)
    : 0;

  const goalsPercentage = analytics && analytics.totalGoals > 0
    ? Math.round((analytics.completedGoals / analytics.totalGoals) * 100)
    : 0;

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={styles.loadingText}>Loading analytics...</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.contentContainer}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.text}
        />
      }
    >
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Analytics</Text>
        <Text style={styles.subtitle}>Project performance overview</Text>
      </View>

      {/* Overview Cards */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Overview</Text>
        <View style={styles.statsGrid}>
          {/* Task Progress */}
          <View style={styles.statCard}>
            <View style={styles.statHeader}>
              <View style={[styles.statIcon, { backgroundColor: '#EFF6FF' }]}>
                <CheckCircle2 size={20} color={colors.primary} strokeWidth={2} />
              </View>
              <Text style={styles.statLabel}>Task Progress</Text>
            </View>
            <Text style={styles.statValue}>{completionPercentage}%</Text>
            <View style={styles.progressBar}>
              <View style={[styles.progressFill, { width: `${completionPercentage}%` }]} />
            </View>
            <Text style={styles.statDetail}>
              {analytics?.completedTasks} of {analytics?.totalTasks} tasks completed
            </Text>
          </View>

          {/* Tasks This Week */}
          <View style={styles.statCard}>
            <View style={styles.statHeader}>
              <View style={[styles.statIcon, { backgroundColor: '#F0FDF4' }]}>
                <TrendingUp size={20} color={colors.success} strokeWidth={2} />
              </View>
              <Text style={styles.statLabel}>This Week</Text>
            </View>
            <View style={styles.statValueRow}>
              <Text style={styles.statValue}>{analytics?.tasksCompletedThisWeek}</Text>
              {analytics && analytics.tasksTrend > 0 && (
                <View style={styles.trendBadge}>
                  <TrendingUp size={12} color={colors.success} strokeWidth={2} />
                  <Text style={styles.trendText}>+{analytics.tasksTrend}%</Text>
                </View>
              )}
            </View>
            <Text style={styles.statDetail}>Tasks completed</Text>
          </View>

          {/* In Progress */}
          <View style={styles.statCard}>
            <View style={styles.statHeader}>
              <View style={[styles.statIcon, { backgroundColor: '#FEF3C7' }]}>
                <Clock size={20} color={colors.warning} strokeWidth={2} />
              </View>
              <Text style={styles.statLabel}>In Progress</Text>
            </View>
            <Text style={styles.statValue}>{analytics?.inProgressTasks}</Text>
            <Text style={styles.statDetail}>Active tasks</Text>
          </View>

          {/* Overdue */}
          <View style={styles.statCard}>
            <View style={styles.statHeader}>
              <View style={[styles.statIcon, { backgroundColor: '#FEF2F2' }]}>
                <AlertCircle size={20} color={colors.danger} strokeWidth={2} />
              </View>
              <Text style={styles.statLabel}>Overdue</Text>
            </View>
            <Text style={[styles.statValue, analytics?.overdueTasks && analytics.overdueTasks > 0 && { color: colors.danger }]}>
              {analytics?.overdueTasks}
            </Text>
            <Text style={styles.statDetail}>Tasks past due date</Text>
          </View>
        </View>
      </View>

      {/* Team & Goals Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Team & Goals</Text>
        <View style={styles.statsRow}>
          {/* Team Members */}
          <View style={[styles.statCard, styles.halfCard]}>
            <View style={styles.statHeader}>
              <View style={[styles.statIcon, { backgroundColor: '#F3E8FF' }]}>
                <Users size={20} color="#9333EA" strokeWidth={2} />
              </View>
              <Text style={styles.statLabel}>Team</Text>
            </View>
            <Text style={styles.statValue}>{analytics?.totalMembers}</Text>
            <Text style={styles.statDetail}>Active members</Text>
          </View>

          {/* Goals Progress */}
          <View style={[styles.statCard, styles.halfCard]}>
            <View style={styles.statHeader}>
              <View style={[styles.statIcon, { backgroundColor: '#ECFDF5' }]}>
                <Target size={20} color={colors.success} strokeWidth={2} />
              </View>
              <Text style={styles.statLabel}>Goals</Text>
            </View>
            <Text style={styles.statValue}>{goalsPercentage}%</Text>
            <Text style={styles.statDetail}>
              {analytics?.completedGoals} of {analytics?.totalGoals} completed
            </Text>
          </View>
        </View>
      </View>

      {/* Time Tracking */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Time Tracking</Text>
        <View style={styles.timeCard}>
          <View style={styles.timeHeader}>
            <View style={[styles.statIcon, { backgroundColor: '#FFF7ED' }]}>
              <Calendar size={20} color="#EA580C" strokeWidth={2} />
            </View>
            <View style={styles.timeInfo}>
              <Text style={styles.timeLabel}>Total Time Logged</Text>
              <Text style={styles.timeValue}>{analytics?.totalTimeLogged}h</Text>
            </View>
          </View>
          <View style={styles.timeBreakdown}>
            <View style={styles.timeItem}>
              <View style={[styles.timeDot, { backgroundColor: colors.primary }]} />
              <Text style={styles.timeItemLabel}>This week</Text>
              <Text style={styles.timeItemValue}>32h</Text>
            </View>
            <View style={styles.timeItem}>
              <View style={[styles.timeDot, { backgroundColor: colors.success }]} />
              <Text style={styles.timeItemLabel}>Last week</Text>
              <Text style={styles.timeItemValue}>28h</Text>
            </View>
            <View style={styles.timeItem}>
              <View style={[styles.timeDot, { backgroundColor: colors.muted }]} />
              <Text style={styles.timeItemLabel}>Average</Text>
              <Text style={styles.timeItemValue}>26h/week</Text>
            </View>
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  contentContainer: {
    padding: 16,
    paddingBottom: 32,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.background,
  },
  loadingText: {
    fontSize: 14,
    color: colors.muted,
  },
  header: {
    marginBottom: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.text,
  },
  subtitle: {
    fontSize: 14,
    color: colors.muted,
    marginTop: 4,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 12,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  statsRow: {
    flexDirection: 'row',
    gap: 12,
  },
  statCard: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    width: '48%',
    flexGrow: 1,
  },
  halfCard: {
    flex: 1,
  },
  statHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  statIcon: {
    width: 36,
    height: 36,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  statLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.muted,
  },
  statValue: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 4,
  },
  statValueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  trendBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: '#ECFDF5',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  trendText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.success,
  },
  statDetail: {
    fontSize: 12,
    color: colors.muted,
  },
  progressBar: {
    height: 6,
    backgroundColor: colors.subtle,
    borderRadius: 3,
    marginVertical: 8,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.primary,
    borderRadius: 3,
  },
  timeCard: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  timeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
  },
  timeInfo: {
    flex: 1,
  },
  timeLabel: {
    fontSize: 13,
    color: colors.muted,
  },
  timeValue: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.text,
  },
  timeBreakdown: {
    gap: 12,
  },
  timeItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  timeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  timeItemLabel: {
    flex: 1,
    fontSize: 14,
    color: colors.text,
  },
  timeItemValue: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
  },
});
