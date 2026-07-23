import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Inbox, CheckSquare, Grid3x3, Users, FolderKanban, Plus, Settings, ChevronRight, X, PanelLeftClose
} from 'lucide-react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/contexts/ToastContext';
import { router, usePathname } from 'expo-router';
import api from '@/services/api';

interface SidebarItem {
  id: string;
  label: string;
  icon: any;
  route: string;
  badge?: number;
}

interface Project {
  id: string;
  name: string;
  color?: string;
  icon?: string;
}

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

const generalMenuItems: SidebarItem[] = [
  {
    id: 'my-inbox',
    label: 'My Inbox',
    icon: Inbox,
    route: '/projects',
  },
  {
    id: 'my-tasks',
    label: 'My Tasks',
    icon: CheckSquare,
    route: '/projects/my-tasks',
  },
  {
    id: 'all-projects',
    label: 'All Projects',
    icon: Grid3x3,
    route: '/projects/all-projects',
  },
  {
    id: 'workload',
    label: 'Workload',
    icon: Users,
    route: '/projects/workload',
  },
];

interface ProjectsSidebarProps {
  onCollapse?: () => void;
}

export default function ProjectsSidebar({ onCollapse }: ProjectsSidebarProps) {
  const { colors } = useTheme();
  const toast = useToast();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
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
      const response = await api.getProjects({ limit: 50 });
      if (response.success && response.data) {
        setProjects(response.data.items || []);
      }
    } catch (error) {
      console.error('Error loading projects:', error);
    } finally {
      setLoading(false);
    }
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
        // Navigate to the new project
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

  const isActive = (route: string) => {
    if (route === '/projects') {
      return pathname === route || pathname === '/projects/';
    }
    return pathname === route || pathname.startsWith(route + '/');
  };

  const isProjectActive = (projectId: string) => {
    return pathname.includes(`/project/${projectId}`);
  };

  return (
    <View style={[styles.container, { backgroundColor: '#fbfbfb' }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: '#ebebeb', paddingTop: insets.top + 12 }]}>
        <Text style={styles.headerTitle}>Projects</Text>
        {onCollapse && (
          <TouchableOpacity style={styles.collapseButton} onPress={onCollapse}>
            <PanelLeftClose size={20} color="#6B7280" strokeWidth={2} />
          </TouchableOpacity>
        )}
      </View>

      {/* Menu Items */}
      <ScrollView style={styles.menuContainer} showsVerticalScrollIndicator={false}>
        {/* General Section */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { paddingHorizontal: 16 }]}>General</Text>
          {generalMenuItems.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.route);

            return (
              <TouchableOpacity
                key={item.id}
                style={[
                  styles.menuItem,
                  active && { backgroundColor: '#f7f7f7' }
                ]}
                onPress={() => router.push(item.route as any)}
              >
                <View style={styles.menuItemContent}>
                  <Icon
                    size={20}
                    color={active ? '#252525' : '#343434'}
                    strokeWidth={2}
                  />
                  <Text
                    style={[
                      styles.menuItemText,
                      { color: active ? '#252525' : '#343434' }
                    ]}
                  >
                    {item.label}
                  </Text>
                </View>
                {item.badge && (
                  <View style={[styles.badge, { backgroundColor: '#343434' }]}>
                    <Text style={styles.badgeText}>{item.badge}</Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Projects Section */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Projects</Text>
            <TouchableOpacity
              style={styles.addButton}
              onPress={() => setShowCreateModal(true)}
            >
              <Plus size={16} color="#6b7280" strokeWidth={2} />
            </TouchableOpacity>
          </View>

          {loading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="small" color="#6b7280" />
            </View>
          ) : projects.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>No projects yet</Text>
              <TouchableOpacity
                style={styles.createFirstButton}
                onPress={() => setShowCreateModal(true)}
              >
                <Text style={styles.createFirstText}>Create your first project</Text>
              </TouchableOpacity>
            </View>
          ) : (
            projects.map((project) => {
              const active = isProjectActive(project.id);

              return (
                <TouchableOpacity
                  key={project.id}
                  style={[
                    styles.menuItem,
                    active && { backgroundColor: '#f7f7f7' }
                  ]}
                  onPress={() => router.push(`/projects/project/${project.id}/tasks` as any)}
                >
                  <View style={styles.menuItemContent}>
                    <View style={[styles.projectIcon, { backgroundColor: project.color || '#F59E0B' }]}>
                      <FolderKanban size={14} color="#FFFFFF" strokeWidth={2} />
                    </View>
                    <Text
                      style={[
                        styles.menuItemText,
                        { color: active ? '#252525' : '#343434' }
                      ]}
                      numberOfLines={1}
                    >
                      {project.name}
                    </Text>
                  </View>
                  <ChevronRight size={16} color="#9ca3af" strokeWidth={2} />
                </TouchableOpacity>
              );
            })
          )}
        </View>
      </ScrollView>

      {/* Bottom Actions */}
      <View style={[styles.bottomActions, { borderTopColor: '#ebebeb' }]}>
        <TouchableOpacity
          style={styles.bottomAction}
          onPress={() => router.push('/projects/settings' as any)}
        >
          <Settings size={20} color="#343434" strokeWidth={2} />
          <Text style={[styles.bottomActionText, { color: '#343434' }]}>Settings</Text>
        </TouchableOpacity>
      </View>

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
                style={styles.textInput}
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
    width: 240,
    height: '100%',
    borderRightWidth: 1,
    borderRightColor: '#ebebeb',
  },
  header: {
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
  },
  collapseButton: {
    padding: 4,
  },
  menuContainer: {
    flex: 1,
    paddingTop: 16,
    paddingBottom: 8,
  },
  section: {
    marginBottom: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    marginBottom: 4,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: '#9ca3af',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  addButton: {
    padding: 4,
  },
  menuItem: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginHorizontal: 8,
    marginVertical: 1,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  menuItemContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  menuItemText: {
    fontSize: 14,
    fontWeight: '500',
    flex: 1,
  },
  projectIcon: {
    width: 24,
    height: 24,
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    minWidth: 24,
    alignItems: 'center',
  },
  badgeText: {
    color: '#fbfbfb',
    fontSize: 12,
    fontWeight: '600',
  },
  loadingContainer: {
    paddingVertical: 20,
    alignItems: 'center',
  },
  emptyState: {
    paddingVertical: 20,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 13,
    color: '#9ca3af',
    textAlign: 'center',
    marginBottom: 12,
  },
  createFirstButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#f3f4f6',
    borderRadius: 6,
  },
  createFirstText: {
    fontSize: 12,
    color: '#4b5563',
    fontWeight: '500',
  },
  bottomActions: {
    borderTopWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 8,
  },
  bottomAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
  },
  bottomActionText: {
    fontSize: 14,
    fontWeight: '500',
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
  textInput: {
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
