import React, { useEffect, useState } from 'react';
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
  FolderKanban,
  Plus,
  ChevronRight,
} from 'lucide-react-native';
import { useCollapsibleHeader } from '@/contexts/CollapsibleHeaderContext';
import { useTopic } from '@weldsuite/realtime/react';
import { topics } from '@weldsuite/realtime/topics';

// Responsive breakpoint
const TABLET_MIN_WIDTH = 768;

export default function ProjectsScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { projects, loading, loadProjects } = useTask();
  const { width: windowWidth } = useWindowDimensions();
  const { onScroll: onCollapsibleScroll, resetHeader } = useCollapsibleHeader();

  const isTablet = windowWidth >= TABLET_MIN_WIDTH;
  const [refreshing, setRefreshing] = useState(false);

  // Reset header when tab becomes active
  useEffect(() => {
    resetHeader();
  }, [resetHeader]);

  useEffect(() => {
    loadProjects();
  }, []);

  // Refresh projects when a project or project_member entity changes on another client
  useTopic(topics.project(), () => {
    loadProjects();
  });
  // project_member events arrive on the task topic prefix; subscribe separately
  useTopic('project_member', () => {
    loadProjects();
  });

  const onRefresh = async () => {
    setRefreshing(true);
    await loadProjects();
    setRefreshing(false);
  };

  // Calculate card width for tablet grid
  const cardWidth = isTablet ? (windowWidth - 64 - 16) / 2 : '100%';

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header for tablet */}
      {isTablet && (
        <View style={styles.header}>
          <Text style={[styles.headerTitle, { color: colors.text }]}>
            Projects ({projects.length})
          </Text>
          <TouchableOpacity
            style={[styles.addButton, { backgroundColor: '#8B5CF6' }]}
            onPress={() => {
              // TODO: Open create project modal
            }}
          >
            <Plus size={18} color="#FFFFFF" strokeWidth={2} />
            <Text style={styles.addButtonText}>New Project</Text>
          </TouchableOpacity>
        </View>
      )}

      <ScrollView
        style={styles.projectsList}
        contentContainerStyle={[
          styles.projectsContent,
          {
            paddingBottom: insets.bottom + 100,
            paddingHorizontal: isTablet ? 24 : 16,
          },
          isTablet && styles.projectsContentTablet,
        ]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#8B5CF6" />
        }
        onScroll={!isTablet ? onCollapsibleScroll : undefined}
        scrollEventThrottle={16}
      >
        {loading.projects && projects.length === 0 ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#8B5CF6" />
            <Text style={[styles.loadingText, { color: colors.muted }]}>Loading projects...</Text>
          </View>
        ) : projects.length === 0 ? (
          <View style={styles.emptyState}>
            <FolderKanban size={48} color={colors.muted} strokeWidth={1.5} />
            <Text style={[styles.emptyTitle, { color: colors.text }]}>No projects yet</Text>
            <Text style={[styles.emptySubtitle, { color: colors.muted }]}>
              Create a project to organize your tasks
            </Text>
          </View>
        ) : (
          projects.map((project) => {
            const completionRate =
              project.taskCount && project.taskCount > 0
                ? Math.round(((project.completedTaskCount || 0) / project.taskCount) * 100)
                : 0;

            return (
              <TouchableOpacity
                key={project.id}
                style={[
                  styles.projectItem,
                  {
                    backgroundColor: colors.background,
                    borderColor: colors.border,
                    width: isTablet ? cardWidth : '100%',
                  },
                ]}
                onPress={() => router.push(`/task/project/${project.id}`)}
              >
                <View
                  style={[
                    styles.projectIcon,
                    { backgroundColor: project.color || '#8B5CF6' },
                  ]}
                >
                  <FolderKanban size={20} color="#FFFFFF" strokeWidth={2} />
                </View>

                <View style={styles.projectContent}>
                  <Text style={[styles.projectName, { color: colors.text }]}>{project.name}</Text>
                  <View style={styles.projectMeta}>
                    <Text style={[styles.projectTasks, { color: colors.muted }]}>
                      {project.taskCount || 0} tasks
                    </Text>
                    <View style={styles.progressContainer}>
                      <View style={[styles.progressBar, { backgroundColor: colors.border }]}>
                        <View
                          style={[
                            styles.progressFill,
                            {
                              backgroundColor: project.color || '#8B5CF6',
                              width: `${completionRate}%`,
                            },
                          ]}
                        />
                      </View>
                      <Text style={[styles.progressText, { color: colors.muted }]}>
                        {completionRate}%
                      </Text>
                    </View>
                  </View>
                </View>

                <ChevronRight size={16} color={colors.muted} />
              </TouchableOpacity>
            );
          })
        )}
      </ScrollView>

      {/* FAB - only on phone */}
      {!isTablet && (
        <TouchableOpacity
          style={styles.fab}
          onPress={() => {
            // TODO: Open create project modal
          }}
        >
          <Plus size={24} color="#FFFFFF" strokeWidth={2} />
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 16,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: -0.3,
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    gap: 6,
  },
  addButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  projectsList: {
    flex: 1,
  },
  projectsContent: {
    paddingVertical: 16,
  },
  projectsContentTablet: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 60,
    width: '100%',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
  },
  emptyState: {
    alignItems: 'center',
    paddingTop: 60,
    width: '100%',
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginTop: 16,
  },
  emptySubtitle: {
    fontSize: 14,
    marginTop: 8,
    textAlign: 'center',
  },
  projectItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 12,
    gap: 14,
  },
  projectIcon: {
    width: 44,
    height: 44,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  projectContent: {
    flex: 1,
  },
  projectName: {
    fontSize: 16,
    fontWeight: '600',
  },
  projectMeta: {
    marginTop: 6,
  },
  projectTasks: {
    fontSize: 13,
  },
  progressContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
    gap: 8,
  },
  progressBar: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
  },
  progressText: {
    fontSize: 12,
    minWidth: 32,
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
