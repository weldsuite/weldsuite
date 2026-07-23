import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { useRouter } from 'expo-router';
import {
  FolderKanban,
  Users,
  Clock,
  CheckCircle,
  AlertCircle,
} from 'lucide-react-native';
import api from '@/services/api';

interface Project {
  id: string;
  name: string;
  description?: string;
  key?: string;
  status: 'planning' | 'active' | 'onhold' | 'completed' | 'cancelled';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  progress: number;
  startDate?: string;
  endDate?: string;
  teamCount: number;
  totalTasks: number;
  completedTasks: number;
  color: string;
  createdAt: string;
}

interface Stats {
  totalProjects: number;
  activeProjects: number;
  completedProjects: number;
  planningProjects: number;
  overdueProjects: number;
}

export default function ProjectsScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [stats, setStats] = useState<Stats>({
    totalProjects: 0,
    activeProjects: 0,
    completedProjects: 0,
    planningProjects: 0,
    overdueProjects: 0,
  });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      await Promise.all([loadStats(), loadProjects()]);
    } catch (error) {
      console.error('Error loading projects data:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const loadStats = async () => {
    try {
      const response = await api.getProjectsStats();
      if (response.success && response.data) {
        setStats(response.data);
      }
    } catch (error) {
      console.error('Error loading projects stats:', error);
    }
  };

  const loadProjects = async () => {
    try {
      const response = await api.getProjects({ limit: 20 });
      if (response.success && response.data?.items) {
        setProjects(response.data.items as Project[]);
      }
    } catch (error) {
      console.error('Error loading projects:', error);
      toast.error('Failed to load projects');
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadData();
  };

  const handleNewProject = () => {
    router.push('/projects/new');
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'active':
        return '#10B981';
      case 'planning':
        return '#F59E0B';
      case 'completed':
        return '#3B82F6';
      case 'onhold':
        return '#6B7280';
      case 'cancelled':
        return '#EF4444';
      default:
        return colors.muted;
    }
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
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
    if (!dateString) return 'No due date';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  if (loading && !refreshing) {
    return (
      <View
        style={[
          styles.centerContainer,
          { backgroundColor: colors.background },
        ]}
      >
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>
          Loading projects...
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={[
        styles.container,
        { backgroundColor: colors.background },
      ]}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
      }
    >
      {/* Stats Overview */}
      <View style={styles.statsContainer}>
        <View style={[styles.statCard, { backgroundColor: colors.background }]}>
          <View style={[styles.statIcon, { backgroundColor: '#3B82F620' }]}>
            <FolderKanban size={20} color="#3B82F6" strokeWidth={2} />
          </View>
          <Text style={[styles.statValue, { color: colors.text }]}>
            {stats.totalProjects}
          </Text>
          <Text style={[styles.statLabel, { color: colors.muted }]}>
            Total Projects
          </Text>
        </View>
        <View style={[styles.statCard, { backgroundColor: colors.background }]}>
          <View style={[styles.statIcon, { backgroundColor: '#10B98120' }]}>
            <CheckCircle size={20} color="#10B981" strokeWidth={2} />
          </View>
          <Text style={[styles.statValue, { color: colors.text }]}>
            {stats.completedProjects}
          </Text>
          <Text style={[styles.statLabel, { color: colors.muted }]}>
            Completed
          </Text>
        </View>
        <View style={[styles.statCard, { backgroundColor: colors.background }]}>
          <View style={[styles.statIcon, { backgroundColor: '#F59E0B20' }]}>
            <Clock size={20} color="#F59E0B" strokeWidth={2} />
          </View>
          <Text style={[styles.statValue, { color: colors.text }]}>
            {stats.activeProjects}
          </Text>
          <Text style={[styles.statLabel, { color: colors.muted }]}>
            In Progress
          </Text>
        </View>
        <View style={[styles.statCard, { backgroundColor: colors.background }]}>
          <View style={[styles.statIcon, { backgroundColor: '#EF444420' }]}>
            <AlertCircle size={20} color="#EF4444" strokeWidth={2} />
          </View>
          <Text style={[styles.statValue, { color: colors.text }]}>
            {stats.overdueProjects}
          </Text>
          <Text style={[styles.statLabel, { color: colors.muted }]}>
            Overdue
          </Text>
        </View>
      </View>

      {/* Projects List */}
      <View style={styles.projectsList}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>
          Projects
        </Text>
        {projects.length === 0 ? (
          <View style={styles.emptyState}>
            <FolderKanban size={48} color={colors.muted} strokeWidth={1.5} />
            <Text style={[styles.emptyTitle, { color: colors.text }]}>
              No projects yet
            </Text>
            <Text style={[styles.emptyText, { color: colors.muted }]}>
              Create your first project to get started
            </Text>
          </View>
        ) : (
          projects.map((project) => (
            <TouchableOpacity
              key={project.id}
              style={[
                styles.projectCard,
                { backgroundColor: colors.background, borderColor: colors.divider },
              ]}
              activeOpacity={0.7}
              onPress={() => router.push(`/projects/project/${project.id}`)}
            >
              <View style={styles.projectHeader}>
                <View style={styles.projectTitleRow}>
                  <Text style={[styles.projectName, { color: colors.text }]}>
                    {project.name}
                  </Text>
                  <View
                    style={[
                      styles.priorityBadge,
                      { backgroundColor: getPriorityColor(project.priority) + '20' },
                    ]}
                  >
                    <Text
                      style={[
                        styles.priorityText,
                        { color: getPriorityColor(project.priority) },
                      ]}
                    >
                      {project.priority}
                    </Text>
                  </View>
                </View>
                <View
                  style={[
                    styles.statusBadge,
                    { backgroundColor: getStatusColor(project.status) + '20' },
                  ]}
                >
                  <View
                    style={[
                      styles.statusDot,
                      { backgroundColor: getStatusColor(project.status) },
                    ]}
                  />
                  <Text
                    style={[
                      styles.statusText,
                      { color: getStatusColor(project.status) },
                    ]}
                  >
                    {project.status}
                  </Text>
                </View>
              </View>

              <View style={styles.progressContainer}>
                <View style={styles.progressHeader}>
                  <Text style={[styles.progressLabel, { color: colors.muted }]}>
                    Progress
                  </Text>
                  <Text style={[styles.progressPercent, { color: colors.text }]}>
                    {Math.round(project.progress)}%
                  </Text>
                </View>
                <View style={[styles.progressBar, { backgroundColor: colors.divider }]}>
                  <View
                    style={[
                      styles.progressFill,
                      {
                        width: `${project.progress}%`,
                        backgroundColor: getStatusColor(project.status),
                      },
                    ]}
                  />
                </View>
              </View>

              <View style={styles.projectFooter}>
                <View style={styles.projectMeta}>
                  <Users size={14} color={colors.muted} strokeWidth={2} />
                  <Text style={[styles.metaText, { color: colors.muted }]}>
                    {project.teamCount} members
                  </Text>
                </View>
                <View style={styles.projectMeta}>
                  <Clock size={14} color={colors.muted} strokeWidth={2} />
                  <Text style={[styles.metaText, { color: colors.muted }]}>
                    {formatDate(project.endDate)}
                  </Text>
                </View>
              </View>
            </TouchableOpacity>
          ))
        )}
      </View>

      {/* Quick Actions */}
      <View style={styles.quickActions}>
        <TouchableOpacity
          style={[styles.actionButton, { backgroundColor: '#3B82F6' }]}
          activeOpacity={0.9}
          onPress={handleNewProject}
        >
          <FolderKanban size={20} color="#FFFFFF" strokeWidth={2} />
          <Text style={styles.actionText}>New Project</Text>
        </TouchableOpacity>
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
    width: '48%',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
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
  projectsList: {
    paddingHorizontal: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 16,
  },
  projectCard: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 12,
  },
  projectHeader: {
    marginBottom: 12,
  },
  projectTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  projectName: {
    fontSize: 16,
    fontWeight: '600',
    flex: 1,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    alignSelf: 'flex-start',
    gap: 4,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusText: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  priorityBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  priorityText: {
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  progressContainer: {
    marginBottom: 12,
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
  projectFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  projectMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  metaText: {
    fontSize: 12,
  },
  quickActions: {
    padding: 16,
    paddingBottom: 32,
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 14,
    borderRadius: 12,
    gap: 8,
  },
  actionText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
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
