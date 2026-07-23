import React from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Home,
  GitBranch,
  LayoutTemplate,
  Plug,
  Play,
  Calendar,
  FileText,
  PanelLeftClose,
} from 'lucide-react-native';
import { router, usePathname } from 'expo-router';

interface SidebarItem {
  id: string;
  label: string;
  icon: any;
  route: string;
}

interface MenuSection {
  title: string;
  items: SidebarItem[];
}

const menuSections: MenuSection[] = [
  {
    title: 'General',
    items: [
      {
        id: 'overview',
        label: 'Overview',
        icon: Home,
        route: '/task',
      },
      {
        id: 'workflows',
        label: 'All Workflows',
        icon: GitBranch,
        route: '/task/workflows',
      },
    ],
  },
  {
    title: 'Resources',
    items: [
      {
        id: 'templates',
        label: 'Templates',
        icon: LayoutTemplate,
        route: '/task/templates',
      },
      {
        id: 'integrations',
        label: 'Integrations',
        icon: Plug,
        route: '/task/integrations',
      },
    ],
  },
  {
    title: 'Execution',
    items: [
      {
        id: 'executions',
        label: 'Executions',
        icon: Play,
        route: '/task/executions',
      },
      {
        id: 'schedules',
        label: 'Schedules',
        icon: Calendar,
        route: '/task/schedules',
      },
      {
        id: 'logs',
        label: 'Logs',
        icon: FileText,
        route: '/task/logs',
      },
    ],
  },
];

interface TaskPagesSidebarProps {
  onCollapse?: () => void;
}

export default function TaskPagesSidebar({ onCollapse }: TaskPagesSidebarProps) {
  const pathname = usePathname();
  const insets = useSafeAreaInsets();

  const isActive = (route: string) => {
    if (route === '/task') {
      return pathname === '/task' || pathname === '/task/' || pathname === '/task/(tabs)';
    }
    return pathname === route || pathname.startsWith(route + '/');
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Text style={styles.headerTitle}>Task</Text>
        {onCollapse && (
          <TouchableOpacity style={styles.collapseButton} onPress={onCollapse}>
            <PanelLeftClose size={20} color="#6B7280" strokeWidth={2} />
          </TouchableOpacity>
        )}
      </View>

      {/* Menu Items */}
      <ScrollView style={styles.menuContainer} showsVerticalScrollIndicator={false}>
        {menuSections.map((section, sectionIndex) => (
          <View key={section.title} style={styles.section}>
            <Text style={styles.sectionTitle}>{section.title}</Text>
            {section.items.map((item) => {
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
                </TouchableOpacity>
              );
            })}
          </View>
        ))}
      </ScrollView>

    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: 240,
    height: '100%',
    backgroundColor: '#fbfbfb',
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
    borderBottomColor: '#ebebeb',
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
  sectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: '#9ca3af',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
    paddingHorizontal: 16,
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
});
