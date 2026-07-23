import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  Platform,
  ScrollView,
} from 'react-native';
import { Stack, useLocalSearchParams, router } from 'expo-router';
import { useTheme } from '@/contexts/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ChevronLeft,
  ListTodo,
  Columns3,
  Table,
  GanttChart,
  PenTool,
  Users,
  FileText,
  Clock,
  Target,
  PanelLeftOpen,
  BarChart3,
} from 'lucide-react-native';
import { useSidebar } from '@/contexts/SidebarContext';
import api from '@/services/api';

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

const tabs = [
  { id: 'tasks', label: 'Tasks', icon: ListTodo },
  { id: 'pipeline', label: 'Pipeline', icon: Columns3 },
  { id: 'table', label: 'Table', icon: Table },
  { id: 'gantt', label: 'Gantt', icon: GanttChart },
  { id: 'whiteboard', label: 'Whiteboard', icon: PenTool },
  { id: 'workload', label: 'Workload', icon: Users },
  { id: 'members', label: 'Members', icon: Users },
  { id: 'files', label: 'Files', icon: FileText },
  { id: 'documents', label: 'Docs', icon: FileText },
  { id: 'timesheet', label: 'Timesheet', icon: Clock },
  { id: 'goals', label: 'Goals', icon: Target },
  { id: 'analytics', label: 'Analytics', icon: BarChart3 },
];

export default function ProjectDetailLayout() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const isTablet = useIsTablet();
  const sidebar = useSidebar();
  const { projectId } = useLocalSearchParams();
  const [activeTab, setActiveTab] = useState('tasks');
  const [projectName, setProjectName] = useState('Project');

  useEffect(() => {
    const loadProject = async () => {
      try {
        const response = await api.getProject(projectId as string);
        if (response.success && response.data) {
          setProjectName(response.data.name || 'Project');
        }
      } catch (error) {
        console.error('Error loading project:', error);
      }
    };
    if (projectId) {
      loadProject();
    }
  }, [projectId]);

  const handleTabPress = (tabId: string) => {
    setActiveTab(tabId);
    router.replace(`/projects/project/${projectId}/${tabId}` as any);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View
        style={[
          styles.header,
          {
            paddingTop: isTablet ? 16 : insets.top,
            backgroundColor: colors.background,
            borderBottomColor: colors.divider,
          },
        ]}
      >
        {/* Back button and title (iPhone only) */}
        {!isTablet && (
          <View style={styles.headerTop}>
            <TouchableOpacity
              style={styles.backButton}
              onPress={() => router.back()}
            >
              <ChevronLeft size={24} color={colors.text} strokeWidth={2} />
            </TouchableOpacity>
            <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
              {projectName}
            </Text>
            <View style={{ width: 40 }} />
          </View>
        )}

        {/* iPad: Show project name */}
        {isTablet && (
          <View style={styles.iPadHeader}>
            {sidebar?.isCollapsed && (
              <TouchableOpacity
                style={styles.expandButton}
                onPress={sidebar.expand}
              >
                <PanelLeftOpen size={20} color="#6B7280" strokeWidth={2} />
              </TouchableOpacity>
            )}
            <Text style={[styles.iPadTitle, { color: colors.text }]}>
              {projectName}
            </Text>
          </View>
        )}

        {/* Tabs */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tabsScroll}
          contentContainerStyle={styles.tabsContainer}
        >
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;

            return (
              <TouchableOpacity
                key={tab.id}
                style={[
                  styles.tab,
                  isActive && styles.tabActive,
                ]}
                onPress={() => handleTabPress(tab.id)}
              >
                <Icon
                  size={16}
                  color={isActive ? '#111827' : colors.muted}
                  strokeWidth={2}
                />
                <Text
                  style={[
                    styles.tabText,
                    { color: isActive ? '#111827' : colors.muted },
                    isActive && styles.tabTextActive,
                  ]}
                >
                  {tab.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {/* Content */}
      <View style={styles.content}>
        <Stack
          screenOptions={{
            headerShown: false,
            animation: 'fade',
          }}
        >
          <Stack.Screen name="tasks" />
          <Stack.Screen name="pipeline" />
          <Stack.Screen name="table" />
          <Stack.Screen name="gantt" />
          <Stack.Screen name="whiteboard" />
          <Stack.Screen name="workload" />
          <Stack.Screen name="members" />
          <Stack.Screen name="files" />
          <Stack.Screen name="documents" />
          <Stack.Screen name="timesheet" />
          <Stack.Screen name="goals" />
          <Stack.Screen name="analytics" />
        </Stack>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    borderBottomWidth: 1,
  },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 12,
  },
  backButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
    flex: 1,
    textAlign: 'center',
  },
  iPadHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    gap: 12,
  },
  iPadTitle: {
    fontSize: 20,
    fontWeight: '600',
  },
  expandButton: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: '#F3F4F6',
    justifyContent: 'center',
    alignItems: 'center',
  },
  tabsScroll: {
    flexGrow: 0,
  },
  tabsContainer: {
    paddingHorizontal: 12,
    gap: 4,
    paddingBottom: 12,
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 6,
  },
  tabActive: {
    backgroundColor: '#F3F4F6',
  },
  tabText: {
    fontSize: 13,
    fontWeight: '500',
  },
  tabTextActive: {
    fontWeight: '600',
  },
  content: {
    flex: 1,
  },
});
