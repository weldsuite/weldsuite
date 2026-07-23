import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  Dimensions,
  Platform,
} from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Users,
  CheckCircle,
  Clock,
  AlertCircle,
} from 'lucide-react-native';
import api from '@/services/api';

interface TeamMember {
  id: string;
  name: string;
  email: string;
  avatar?: string;
  role?: string;
  taskStats: {
    total: number;
    todo: number;
    inProgress: number;
    done: number;
    overdue: number;
  };
  workloadLevel: 'low' | 'medium' | 'high' | 'overloaded';
}

const workloadConfig = {
  low: { label: 'Low', color: '#10B981', bgColor: '#D1FAE5' },
  medium: { label: 'Medium', color: '#F59E0B', bgColor: '#FEF3C7' },
  high: { label: 'High', color: '#EF4444', bgColor: '#FEE2E2' },
  overloaded: { label: 'Overloaded', color: '#DC2626', bgColor: '#FEE2E2' },
};

function useIsTablet() {
  const [isTablet, setIsTablet] = useState(false);

  useEffect(() => {
    const checkTablet = () => {
      const { width } = Dimensions.get('window');
      setIsTablet(Platform.OS === 'ios' && width >= 768);
    };

    checkTablet();
    const subscription = Dimensions.addEventListener('change', checkTablet);
    return () => subscription.remove();
  }, []);

  return isTablet;
}

export default function WorkloadScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const isTablet = useIsTablet();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    loadWorkload();
  }, []);

  const loadWorkload = async () => {
    try {
      setLoading(true);
      // For now, we'll use mock data until we have a workload API
      // In production, this would call api.getWorkload()

      // Simulate loading
      await new Promise(resolve => setTimeout(resolve, 500));

      // Mock data
      const mockMembers: TeamMember[] = [
        {
          id: '1',
          name: 'John Smith',
          email: 'john@example.com',
          role: 'Developer',
          taskStats: { total: 12, todo: 3, inProgress: 5, done: 4, overdue: 1 },
          workloadLevel: 'high',
        },
        {
          id: '2',
          name: 'Sarah Johnson',
          email: 'sarah@example.com',
          role: 'Designer',
          taskStats: { total: 8, todo: 2, inProgress: 3, done: 3, overdue: 0 },
          workloadLevel: 'medium',
        },
        {
          id: '3',
          name: 'Mike Wilson',
          email: 'mike@example.com',
          role: 'Developer',
          taskStats: { total: 5, todo: 1, inProgress: 2, done: 2, overdue: 0 },
          workloadLevel: 'low',
        },
        {
          id: '4',
          name: 'Emily Davis',
          email: 'emily@example.com',
          role: 'Project Manager',
          taskStats: { total: 15, todo: 5, inProgress: 6, done: 2, overdue: 3 },
          workloadLevel: 'overloaded',
        },
      ];

      setMembers(mockMembers);
    } catch (error) {
      console.error('Error loading workload:', error);
      toast.error('Failed to load workload data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadWorkload();
  };

  const getTotalStats = () => {
    return members.reduce(
      (acc, member) => ({
        total: acc.total + member.taskStats.total,
        todo: acc.todo + member.taskStats.todo,
        inProgress: acc.inProgress + member.taskStats.inProgress,
        done: acc.done + member.taskStats.done,
        overdue: acc.overdue + member.taskStats.overdue,
      }),
      { total: 0, todo: 0, inProgress: 0, done: 0, overdue: 0 }
    );
  };

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  if (loading && !refreshing) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>
          Loading workload...
        </Text>
      </View>
    );
  }

  const stats = getTotalStats();

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: colors.background,
          paddingTop: isTablet ? 20 : insets.top + 45,
        },
      ]}
    >
      {/* Header */}
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.text }]}>Workload</Text>
        <Text style={[styles.subtitle, { color: colors.muted }]}>
          Team capacity overview
        </Text>
      </View>

      <ScrollView
        style={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
      >
        {/* Stats Overview */}
        <View style={styles.statsContainer}>
          <View style={[styles.statCard, { backgroundColor: colors.card, borderColor: colors.divider }]}>
            <View style={[styles.statIcon, { backgroundColor: '#3B82F620' }]}>
              <Users size={20} color="#3B82F6" strokeWidth={2} />
            </View>
            <Text style={[styles.statValue, { color: colors.text }]}>{members.length}</Text>
            <Text style={[styles.statLabel, { color: colors.muted }]}>Team Members</Text>
          </View>
          <View style={[styles.statCard, { backgroundColor: colors.card, borderColor: colors.divider }]}>
            <View style={[styles.statIcon, { backgroundColor: '#10B98120' }]}>
              <CheckCircle size={20} color="#10B981" strokeWidth={2} />
            </View>
            <Text style={[styles.statValue, { color: colors.text }]}>{stats.done}</Text>
            <Text style={[styles.statLabel, { color: colors.muted }]}>Completed</Text>
          </View>
          <View style={[styles.statCard, { backgroundColor: colors.card, borderColor: colors.divider }]}>
            <View style={[styles.statIcon, { backgroundColor: '#F59E0B20' }]}>
              <Clock size={20} color="#F59E0B" strokeWidth={2} />
            </View>
            <Text style={[styles.statValue, { color: colors.text }]}>{stats.inProgress}</Text>
            <Text style={[styles.statLabel, { color: colors.muted }]}>In Progress</Text>
          </View>
          <View style={[styles.statCard, { backgroundColor: colors.card, borderColor: colors.divider }]}>
            <View style={[styles.statIcon, { backgroundColor: '#EF444420' }]}>
              <AlertCircle size={20} color="#EF4444" strokeWidth={2} />
            </View>
            <Text style={[styles.statValue, { color: colors.text }]}>{stats.overdue}</Text>
            <Text style={[styles.statLabel, { color: colors.muted }]}>Overdue</Text>
          </View>
        </View>

        {/* Team Members */}
        <View style={styles.teamSection}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Team Members</Text>

          {members.length === 0 ? (
            <View style={styles.emptyState}>
              <Users size={48} color={colors.muted} strokeWidth={1.5} />
              <Text style={[styles.emptyTitle, { color: colors.text }]}>
                No team members
              </Text>
              <Text style={[styles.emptyText, { color: colors.muted }]}>
                Add team members to see workload distribution
              </Text>
            </View>
          ) : (
            members.map((member) => {
              const workload = workloadConfig[member.workloadLevel];
              const completionRate = member.taskStats.total > 0
                ? Math.round((member.taskStats.done / member.taskStats.total) * 100)
                : 0;

              return (
                <View
                  key={member.id}
                  style={[
                    styles.memberCard,
                    { backgroundColor: colors.card, borderColor: colors.divider },
                  ]}
                >
                  <View style={styles.memberHeader}>
                    <View style={styles.memberAvatar}>
                      <Text style={styles.memberInitials}>
                        {getInitials(member.name)}
                      </Text>
                    </View>
                    <View style={styles.memberInfo}>
                      <Text style={[styles.memberName, { color: colors.text }]}>
                        {member.name}
                      </Text>
                      <Text style={[styles.memberRole, { color: colors.muted }]}>
                        {member.role || 'Team Member'}
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.workloadBadge,
                        { backgroundColor: workload.bgColor },
                      ]}
                    >
                      <Text style={[styles.workloadText, { color: workload.color }]}>
                        {workload.label}
                      </Text>
                    </View>
                  </View>

                  {/* Progress Bar */}
                  <View style={styles.memberProgress}>
                    <View style={styles.progressHeader}>
                      <Text style={[styles.progressLabel, { color: colors.muted }]}>
                        Completion Rate
                      </Text>
                      <Text style={[styles.progressPercent, { color: colors.text }]}>
                        {completionRate}%
                      </Text>
                    </View>
                    <View style={[styles.progressBar, { backgroundColor: colors.divider }]}>
                      <View
                        style={[
                          styles.progressFill,
                          {
                            width: `${completionRate}%`,
                            backgroundColor: workload.color,
                          },
                        ]}
                      />
                    </View>
                  </View>

                  {/* Task Stats */}
                  <View style={styles.taskStatsContainer}>
                    <View style={styles.taskStat}>
                      <Text style={[styles.taskStatValue, { color: colors.text }]}>
                        {member.taskStats.todo}
                      </Text>
                      <Text style={[styles.taskStatLabel, { color: colors.muted }]}>
                        To Do
                      </Text>
                    </View>
                    <View style={styles.taskStat}>
                      <Text style={[styles.taskStatValue, { color: colors.text }]}>
                        {member.taskStats.inProgress}
                      </Text>
                      <Text style={[styles.taskStatLabel, { color: colors.muted }]}>
                        In Progress
                      </Text>
                    </View>
                    <View style={styles.taskStat}>
                      <Text style={[styles.taskStatValue, { color: colors.text }]}>
                        {member.taskStats.done}
                      </Text>
                      <Text style={[styles.taskStatLabel, { color: colors.muted }]}>
                        Done
                      </Text>
                    </View>
                    {member.taskStats.overdue > 0 && (
                      <View style={styles.taskStat}>
                        <Text style={[styles.taskStatValue, { color: '#EF4444' }]}>
                          {member.taskStats.overdue}
                        </Text>
                        <Text style={[styles.taskStatLabel, { color: colors.muted }]}>
                          Overdue
                        </Text>
                      </View>
                    )}
                  </View>
                </View>
              );
            })
          )}
        </View>

        <View style={{ height: 100 }} />
      </ScrollView>
    </View>
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
    fontSize: 14,
  },
  header: {
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    fontSize: 14,
    marginTop: 4,
  },
  content: {
    flex: 1,
  },
  statsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    padding: 16,
    gap: 12,
  },
  statCard: {
    width: '48%',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
  },
  statIcon: {
    width: 36,
    height: 36,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  statValue: {
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 4,
  },
  statLabel: {
    fontSize: 12,
  },
  teamSection: {
    paddingHorizontal: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 16,
  },
  memberCard: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 12,
  },
  memberHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  memberAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#E5E7EB',
    justifyContent: 'center',
    alignItems: 'center',
  },
  memberInitials: {
    fontSize: 14,
    fontWeight: '600',
    color: '#6B7280',
  },
  memberInfo: {
    flex: 1,
  },
  memberName: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 2,
  },
  memberRole: {
    fontSize: 12,
  },
  workloadBadge: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
  },
  workloadText: {
    fontSize: 11,
    fontWeight: '600',
  },
  memberProgress: {
    marginTop: 16,
  },
  progressHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  progressLabel: {
    fontSize: 12,
  },
  progressPercent: {
    fontSize: 12,
    fontWeight: '600',
  },
  progressBar: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
  },
  taskStatsContainer: {
    flexDirection: 'row',
    marginTop: 16,
    gap: 20,
  },
  taskStat: {
    alignItems: 'center',
  },
  taskStatValue: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 2,
  },
  taskStatLabel: {
    fontSize: 11,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 60,
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
