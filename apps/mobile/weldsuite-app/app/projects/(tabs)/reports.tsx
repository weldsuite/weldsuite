import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  BarChart3,
  TrendingUp,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Target,
  Trophy,
} from 'lucide-react-native';
import api, { ProjectReports } from '@/services/api';

export default function ReportsScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const [reports, setReports] = useState<ProjectReports | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    loadReports();
  }, []);

  const loadReports = async () => {
    try {
      setLoading(true);
      const response = await api.getProjectReports();
      if (response.success && response.data) {
        setReports(response.data);
      }
    } catch (error) {
      console.error('Error loading project reports:', error);
      toast.error('Failed to load reports');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadReports();
  };

  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case 'planning':
        return '#F59E0B';
      case 'active':
        return '#3B82F6';
      case 'completed':
        return '#10B981';
      case 'onhold':
        return '#6B7280';
      case 'cancelled':
        return '#EF4444';
      default:
        return colors.muted;
    }
  };

  const getHealthColor = (health: string) => {
    switch (health.toLowerCase()) {
      case 'healthy':
      case 'on_track':
        return '#10B981';
      case 'at_risk':
        return '#F59E0B';
      case 'off_track':
      case 'critical':
        return '#EF4444';
      default:
        return colors.muted;
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
  };

  if (loading && !refreshing) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>
          Loading reports...
        </Text>
      </View>
    );
  }

  if (!reports) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <BarChart3 size={48} color={colors.muted} strokeWidth={1.5} />
        <Text style={[styles.emptyTitle, { color: colors.text }]}>No data available</Text>
        <Text style={[styles.emptyText, { color: colors.muted }]}>
          Reports will appear here once you have projects
        </Text>
      </View>
    );
  }

  const maxStatusCount = Math.max(...reports.statusBreakdown.map(s => s.count), 1);
  const maxHealthCount = Math.max(...reports.healthSummary.map(h => h.count), 1);

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top + 45 }]}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
      }
    >
      {/* Key Metrics */}
      <View style={styles.metricsContainer}>
        <View style={[styles.metricCard, { backgroundColor: colors.background, borderColor: colors.divider }]}>
          <View style={[styles.metricIcon, { backgroundColor: '#10B98120' }]}>
            <Target size={20} color="#10B981" strokeWidth={2} />
          </View>
          <Text style={[styles.metricValue, { color: colors.text }]}>
            {reports.completionRate.toFixed(0)}%
          </Text>
          <Text style={[styles.metricLabel, { color: colors.muted }]}>Completion Rate</Text>
        </View>
        <View style={[styles.metricCard, { backgroundColor: colors.background, borderColor: colors.divider }]}>
          <View style={[styles.metricIcon, { backgroundColor: '#3B82F620' }]}>
            <TrendingUp size={20} color="#3B82F6" strokeWidth={2} />
          </View>
          <Text style={[styles.metricValue, { color: colors.text }]}>
            {reports.avgProgress.toFixed(0)}%
          </Text>
          <Text style={[styles.metricLabel, { color: colors.muted }]}>Avg Progress</Text>
        </View>
      </View>

      {/* Hours Overview */}
      <View style={[styles.section, { borderColor: colors.divider }]}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>Hours Overview</Text>
        <View style={styles.hoursGrid}>
          <View style={styles.hoursItem}>
            <Clock size={18} color={colors.muted} strokeWidth={2} />
            <Text style={[styles.hoursValue, { color: colors.text }]}>
              {reports.totalBudgetedHours.toFixed(0)}h
            </Text>
            <Text style={[styles.hoursLabel, { color: colors.muted }]}>Budgeted</Text>
          </View>
          <View style={styles.hoursItem}>
            <CheckCircle2 size={18} color="#10B981" strokeWidth={2} />
            <Text style={[styles.hoursValue, { color: colors.text }]}>
              {reports.totalActualHours.toFixed(0)}h
            </Text>
            <Text style={[styles.hoursLabel, { color: colors.muted }]}>Actual</Text>
          </View>
          <View style={styles.hoursItem}>
            <AlertTriangle
              size={18}
              color={reports.hoursVariance > 0 ? '#EF4444' : '#10B981'}
              strokeWidth={2}
            />
            <Text
              style={[
                styles.hoursValue,
                { color: reports.hoursVariance > 0 ? '#EF4444' : '#10B981' },
              ]}
            >
              {reports.hoursVariance > 0 ? '+' : ''}{reports.hoursVariance.toFixed(0)}h
            </Text>
            <Text style={[styles.hoursLabel, { color: colors.muted }]}>Variance</Text>
          </View>
        </View>
      </View>

      {/* Project Status Breakdown */}
      <View style={[styles.section, { borderColor: colors.divider }]}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>Status Breakdown</Text>
        {reports.statusBreakdown.map((status, index) => (
          <View key={index} style={styles.barChartRow}>
            <View style={styles.barLabelContainer}>
              <View style={[styles.statusDot, { backgroundColor: getStatusColor(status.status) }]} />
              <Text style={[styles.barLabel, { color: colors.text }]}>
                {status.status.replace('_', ' ')}
              </Text>
            </View>
            <View style={styles.barContainer}>
              <View
                style={[
                  styles.bar,
                  {
                    width: `${(status.count / maxStatusCount) * 100}%`,
                    backgroundColor: getStatusColor(status.status),
                  },
                ]}
              />
            </View>
            <Text style={[styles.barValue, { color: colors.text }]}>{status.count}</Text>
          </View>
        ))}
      </View>

      {/* Health Summary */}
      <View style={[styles.section, { borderColor: colors.divider }]}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>Health Summary</Text>
        {reports.healthSummary.map((health, index) => (
          <View key={index} style={styles.barChartRow}>
            <View style={styles.barLabelContainer}>
              <View style={[styles.statusDot, { backgroundColor: getHealthColor(health.health) }]} />
              <Text style={[styles.barLabel, { color: colors.text }]}>
                {health.health.replace('_', ' ')}
              </Text>
            </View>
            <View style={styles.barContainer}>
              <View
                style={[
                  styles.bar,
                  {
                    width: `${(health.count / maxHealthCount) * 100}%`,
                    backgroundColor: getHealthColor(health.health),
                  },
                ]}
              />
            </View>
            <Text style={[styles.barValue, { color: colors.text }]}>{health.count}</Text>
          </View>
        ))}
      </View>

      {/* Top Projects */}
      <View style={[styles.section, { borderColor: colors.divider }]}>
        <View style={styles.sectionHeader}>
          <Trophy size={18} color="#F59E0B" strokeWidth={2} />
          <Text style={[styles.sectionTitle, { color: colors.text, marginBottom: 0, marginLeft: 8 }]}>
            Top Projects
          </Text>
        </View>
        {reports.topProjects.map((project, index) => (
          <View
            key={project.id}
            style={[styles.projectRow, { borderColor: colors.divider }]}
          >
            <View style={styles.projectRank}>
              <Text style={[styles.rankText, { color: index < 3 ? '#F59E0B' : colors.muted }]}>
                #{index + 1}
              </Text>
            </View>
            <View style={styles.projectInfo}>
              <Text style={[styles.projectName, { color: colors.text }]} numberOfLines={1}>
                {project.name}
              </Text>
              <View style={styles.projectMeta}>
                <Text style={[styles.projectProgress, { color: colors.muted }]}>
                  {project.completedTasks}/{project.totalTasks} tasks
                </Text>
              </View>
            </View>
            <View style={styles.progressCircle}>
              <Text style={[styles.progressValue, { color: '#10B981' }]}>
                {project.progress.toFixed(0)}%
              </Text>
            </View>
          </View>
        ))}
      </View>

      {/* Recent Completed Tasks */}
      <View style={[styles.section, { borderColor: colors.divider, marginBottom: 32 }]}>
        <View style={styles.sectionHeader}>
          <CheckCircle2 size={18} color="#10B981" strokeWidth={2} />
          <Text style={[styles.sectionTitle, { color: colors.text, marginBottom: 0, marginLeft: 8 }]}>
            Recent Completions
          </Text>
        </View>
        {reports.recentCompletedTasks.length === 0 ? (
          <Text style={[styles.emptyListText, { color: colors.muted }]}>
            No completed tasks yet
          </Text>
        ) : (
          reports.recentCompletedTasks.map((task, index) => (
            <View
              key={task.id}
              style={[
                styles.completedTaskRow,
                index < reports.recentCompletedTasks.length - 1 && { borderBottomWidth: 1, borderColor: colors.divider },
              ]}
            >
              <CheckCircle2 size={14} color="#10B981" strokeWidth={2} />
              <View style={styles.taskInfo}>
                <Text style={[styles.taskTitle, { color: colors.text }]} numberOfLines={1}>
                  {task.title}
                </Text>
                <Text style={[styles.taskProject, { color: colors.muted }]}>
                  {task.projectName} • {formatDate(task.completedDate)}
                </Text>
              </View>
            </View>
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
    paddingHorizontal: 32,
  },
  loadingText: {
    marginTop: 16,
    fontSize: 12,
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
  metricsContainer: {
    flexDirection: 'row',
    padding: 16,
    gap: 12,
  },
  metricCard: {
    flex: 1,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
  },
  metricIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  metricValue: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 4,
  },
  metricLabel: {
    fontSize: 12,
  },
  section: {
    marginHorizontal: 16,
    marginBottom: 20,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 16,
    textTransform: 'capitalize',
  },
  hoursGrid: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  hoursItem: {
    alignItems: 'center',
    gap: 6,
  },
  hoursValue: {
    fontSize: 18,
    fontWeight: '600',
  },
  hoursLabel: {
    fontSize: 11,
  },
  barChartRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  barLabelContainer: {
    width: 90,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  barLabel: {
    fontSize: 12,
    textTransform: 'capitalize',
  },
  barContainer: {
    flex: 1,
    height: 8,
    backgroundColor: '#E5E7EB',
    borderRadius: 4,
    marginHorizontal: 8,
    overflow: 'hidden',
  },
  bar: {
    height: '100%',
    borderRadius: 4,
  },
  barValue: {
    width: 30,
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'right',
  },
  projectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  projectRank: {
    width: 30,
  },
  rankText: {
    fontSize: 14,
    fontWeight: '600',
  },
  projectInfo: {
    flex: 1,
    marginRight: 12,
  },
  projectName: {
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 2,
  },
  projectMeta: {
    flexDirection: 'row',
  },
  projectProgress: {
    fontSize: 11,
  },
  progressCircle: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressValue: {
    fontSize: 14,
    fontWeight: '600',
  },
  completedTaskRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    gap: 10,
  },
  taskInfo: {
    flex: 1,
  },
  taskTitle: {
    fontSize: 13,
    fontWeight: '500',
    marginBottom: 2,
  },
  taskProject: {
    fontSize: 11,
  },
  emptyListText: {
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 16,
  },
});
