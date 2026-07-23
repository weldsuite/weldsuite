import React, { useState, useEffect, useMemo } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Dimensions,
  Platform,
  TextInput,
  Modal,
  KeyboardAvoidingView,
} from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import {
  FolderKanban,
  Search,
  Plus,
  Users,
  Clock,
  CheckCircle,
  ChevronRight,
  X,
} from 'lucide-react-native';
import api from '@/services/api';

const PROJECT_COLORS = [
  '#F59E0B', // Amber
  '#EF4444', // Red
  '#10B981', // Green
  '#3B82F6', // Blue
  '#8B5CF6', // Purple
  '#EC4899', // Pink
  '#06B6D4', // Cyan
  '#F97316', // Orange
];

interface Project {
  id: string;
  name: string;
  description?: string;
  status: 'planning' | 'active' | 'on_hold' | 'completed' | 'cancelled';
  color?: string;
  progress: number;
  taskCount: number;
  completedTaskCount: number;
  memberCount: number;
  startDate?: string;
  endDate?: string;
  createdAt: string;
}

const statusConfig = {
  planning: { label: 'Planning', color: '#F59E0B', bgColor: '#FEF3C7' },
  active: { label: 'Active', color: '#10B981', bgColor: '#D1FAE5' },
  on_hold: { label: 'On Hold', color: '#6B7280', bgColor: '#F3F4F6' },
  completed: { label: 'Completed', color: '#3B82F6', bgColor: '#DBEAFE' },
  cancelled: { label: 'Cancelled', color: '#EF4444', bgColor: '#FEE2E2' },
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

export default function AllProjectsScreen() {
  const { colors } = useTheme();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const isTablet = useIsTablet();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectColor, setNewProjectColor] = useState(PROJECT_COLORS[0]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    loadProjects();
  }, []);

  const loadProjects = async () => {
    try {
      setLoading(true);
      const response = await api.getProjects({ limit: 100 });
      if (response.success && response.data) {
        setProjects(response.data.items || []);
      }
    } catch (error) {
      console.error('Error loading projects:', error);
      toast.error('Failed to load projects');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadProjects();
  };

  const handleCreateProject = async () => {
    if (!newProjectName.trim()) {
      toast.error('Please enter a project name');
      return;
    }

    try {
      setCreating(true);
      const response = await api.createProject({
        name: newProjectName.trim(),
        color: newProjectColor,
      });

      if (response.success && response.data) {
        toast.success('Project created successfully');
        setShowCreateModal(false);
        setNewProjectName('');
        setNewProjectColor(PROJECT_COLORS[0]);
        await loadProjects();
        router.push(`/projects/project/${response.data.id}/tasks` as any);
      } else {
        toast.error(response.error || 'Failed to create project');
      }
    } catch (error) {
      console.error('Error creating project:', error);
      toast.error('Failed to create project');
    } finally {
      setCreating(false);
    }
  };

  const filteredProjects = useMemo(() => {
    return projects.filter((project) => {
      const matchesSearch =
        project.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        project.description?.toLowerCase().includes(searchQuery.toLowerCase());

      const matchesStatus =
        statusFilter === 'all' || project.status === statusFilter;

      return matchesSearch && matchesStatus;
    });
  }, [projects, searchQuery, statusFilter]);

  const formatDate = (dateString?: string) => {
    if (!dateString) return null;
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  if (loading && !refreshing) {
    return (
      <View style={[styles.centerContainer, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.text} />
        <Text style={[styles.loadingText, { color: colors.muted }]}>
          Loading projects...
        </Text>
      </View>
    );
  }

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
        <View style={styles.headerTop}>
          <View>
            <Text style={[styles.title, { color: colors.text }]}>All Projects</Text>
            <Text style={[styles.subtitle, { color: colors.muted }]}>
              {filteredProjects.length} project{filteredProjects.length !== 1 ? 's' : ''}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.addButton}
            onPress={() => setShowCreateModal(true)}
          >
            <Plus size={20} color="#FFFFFF" strokeWidth={2} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Search & Filters */}
      <View style={styles.filtersContainer}>
        <View style={[styles.searchContainer, { backgroundColor: colors.card }]}>
          <Search size={18} color={colors.muted} strokeWidth={2} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search projects..."
            placeholderTextColor={colors.muted}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.filterScroll}
        >
          <View style={styles.filterTabs}>
            <TouchableOpacity
              style={[
                styles.filterTab,
                statusFilter === 'all' && styles.filterTabActive,
              ]}
              onPress={() => setStatusFilter('all')}
            >
              <Text
                style={[
                  styles.filterTabText,
                  { color: statusFilter === 'all' ? '#FFFFFF' : colors.muted },
                ]}
              >
                All
              </Text>
            </TouchableOpacity>
            {Object.entries(statusConfig).map(([key, config]) => (
              <TouchableOpacity
                key={key}
                style={[
                  styles.filterTab,
                  statusFilter === key && { backgroundColor: config.color },
                ]}
                onPress={() => setStatusFilter(key)}
              >
                <Text
                  style={[
                    styles.filterTabText,
                    { color: statusFilter === key ? '#FFFFFF' : colors.muted },
                  ]}
                >
                  {config.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>
      </View>

      {/* Projects List */}
      <ScrollView
        style={styles.projectList}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
      >
        {filteredProjects.length === 0 ? (
          <View style={styles.emptyState}>
            <FolderKanban size={48} color={colors.muted} strokeWidth={1.5} />
            <Text style={[styles.emptyTitle, { color: colors.text }]}>
              No projects found
            </Text>
            <Text style={[styles.emptyText, { color: colors.muted }]}>
              {searchQuery || statusFilter !== 'all'
                ? 'Try adjusting your filters'
                : 'Create your first project to get started'}
            </Text>
          </View>
        ) : (
          filteredProjects.map((project) => {
            const status = statusConfig[project.status] || statusConfig.planning;
            const progressPercent = project.taskCount > 0
              ? Math.round((project.completedTaskCount / project.taskCount) * 100)
              : 0;

            return (
              <TouchableOpacity
                key={project.id}
                style={[
                  styles.projectCard,
                  { backgroundColor: colors.card, borderColor: colors.divider },
                ]}
                activeOpacity={0.7}
                onPress={() => router.push(`/projects/project/${project.id}/tasks` as any)}
              >
                <View style={styles.projectHeader}>
                  <View
                    style={[
                      styles.projectIcon,
                      { backgroundColor: project.color || '#F59E0B' },
                    ]}
                  >
                    <FolderKanban size={20} color="#FFFFFF" strokeWidth={2} />
                  </View>
                  <View style={styles.projectInfo}>
                    <Text
                      style={[styles.projectName, { color: colors.text }]}
                      numberOfLines={1}
                    >
                      {project.name}
                    </Text>
                    <View
                      style={[
                        styles.statusBadge,
                        { backgroundColor: status.bgColor },
                      ]}
                    >
                      <Text style={[styles.statusText, { color: status.color }]}>
                        {status.label}
                      </Text>
                    </View>
                  </View>
                  <ChevronRight size={20} color={colors.muted} strokeWidth={2} />
                </View>

                {project.description && (
                  <Text
                    style={[styles.projectDescription, { color: colors.muted }]}
                    numberOfLines={2}
                  >
                    {project.description}
                  </Text>
                )}

                {/* Progress Bar */}
                <View style={styles.progressContainer}>
                  <View style={styles.progressHeader}>
                    <Text style={[styles.progressLabel, { color: colors.muted }]}>
                      Progress
                    </Text>
                    <Text style={[styles.progressPercent, { color: colors.text }]}>
                      {progressPercent}%
                    </Text>
                  </View>
                  <View style={[styles.progressBar, { backgroundColor: colors.divider }]}>
                    <View
                      style={[
                        styles.progressFill,
                        {
                          width: `${progressPercent}%`,
                          backgroundColor: status.color,
                        },
                      ]}
                    />
                  </View>
                </View>

                {/* Project Stats */}
                <View style={styles.projectStats}>
                  <View style={styles.stat}>
                    <CheckCircle size={14} color={colors.muted} strokeWidth={2} />
                    <Text style={[styles.statText, { color: colors.muted }]}>
                      {project.completedTaskCount}/{project.taskCount} tasks
                    </Text>
                  </View>
                  <View style={styles.stat}>
                    <Users size={14} color={colors.muted} strokeWidth={2} />
                    <Text style={[styles.statText, { color: colors.muted }]}>
                      {project.memberCount} member{project.memberCount !== 1 ? 's' : ''}
                    </Text>
                  </View>
                  {project.endDate && (
                    <View style={styles.stat}>
                      <Clock size={14} color={colors.muted} strokeWidth={2} />
                      <Text style={[styles.statText, { color: colors.muted }]}>
                        Due {formatDate(project.endDate)}
                      </Text>
                    </View>
                  )}
                </View>
              </TouchableOpacity>
            );
          })
        )}

        <View style={{ height: 100 }} />
      </ScrollView>

      {/* Create Project Modal */}
      <Modal
        visible={showCreateModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowCreateModal(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalOverlay}
        >
          <TouchableOpacity
            style={styles.modalBackdrop}
            activeOpacity={1}
            onPress={() => setShowCreateModal(false)}
          />
          <View style={styles.modalContent}>
            {/* Modal Header */}
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Create Project</Text>
              <TouchableOpacity
                style={styles.modalCloseButton}
                onPress={() => setShowCreateModal(false)}
              >
                <X size={20} color="#6b7280" strokeWidth={2} />
              </TouchableOpacity>
            </View>

            {/* Project Name Input */}
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Project Name</Text>
              <TextInput
                style={styles.modalTextInput}
                placeholder="e.g., Website Redesign"
                placeholderTextColor="#9ca3af"
                value={newProjectName}
                onChangeText={setNewProjectName}
                autoFocus
              />
            </View>

            {/* Color Picker */}
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Project Color</Text>
              <View style={styles.colorPicker}>
                {PROJECT_COLORS.map((color) => (
                  <TouchableOpacity
                    key={color}
                    style={[
                      styles.colorOption,
                      { backgroundColor: color },
                      newProjectColor === color && styles.colorOptionSelected,
                    ]}
                    onPress={() => setNewProjectColor(color)}
                  />
                ))}
              </View>
            </View>

            {/* Actions */}
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={() => setShowCreateModal(false)}
              >
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.createButton,
                  (!newProjectName.trim() || creating) && styles.createButtonDisabled,
                ]}
                onPress={handleCreateProject}
                disabled={!newProjectName.trim() || creating}
              >
                {creating ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Text style={styles.createButtonText}>Create Project</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
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
  headerTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    fontSize: 14,
    marginTop: 4,
  },
  addButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#111827',
    justifyContent: 'center',
    alignItems: 'center',
  },
  filtersContainer: {
    paddingHorizontal: 16,
    gap: 12,
    marginBottom: 16,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    padding: 0,
  },
  filterScroll: {
    marginHorizontal: -16,
    paddingHorizontal: 16,
  },
  filterTabs: {
    flexDirection: 'row',
    gap: 8,
  },
  filterTab: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#F3F4F6',
  },
  filterTabActive: {
    backgroundColor: '#111827',
  },
  filterTabText: {
    fontSize: 13,
    fontWeight: '500',
  },
  projectList: {
    flex: 1,
    paddingHorizontal: 16,
  },
  projectCard: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 12,
  },
  projectHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  projectIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  projectInfo: {
    flex: 1,
  },
  projectName: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  statusBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 11,
    fontWeight: '600',
  },
  projectDescription: {
    fontSize: 13,
    marginTop: 12,
    lineHeight: 18,
  },
  progressContainer: {
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
  projectStats: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 12,
    flexWrap: 'wrap',
  },
  stat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  statText: {
    fontSize: 12,
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
  // Modal styles
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  modalContent: {
    width: 400,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.2,
    shadowRadius: 20,
    elevation: 10,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
  },
  modalCloseButton: {
    padding: 4,
  },
  inputGroup: {
    marginBottom: 20,
  },
  inputLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: '#374151',
    marginBottom: 8,
  },
  modalTextInput: {
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: '#111827',
  },
  colorPicker: {
    flexDirection: 'row',
    gap: 10,
  },
  colorOption: {
    width: 32,
    height: 32,
    borderRadius: 16,
  },
  colorOptionSelected: {
    borderWidth: 3,
    borderColor: '#111827',
  },
  modalActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#F3F4F6',
    alignItems: 'center',
  },
  cancelButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
  },
  createButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#111827',
    alignItems: 'center',
  },
  createButtonDisabled: {
    opacity: 0.5,
  },
  createButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  },
});
