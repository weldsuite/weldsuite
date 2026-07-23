import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  TouchableOpacity,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronLeft, CheckSquare, Plus } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useProject, useProjectTasks } from '@/hooks/use-weldflow';
import { TaskCard } from '@/components/TaskCard';
import { StatusBadge } from '@/components/StatusBadge';
import { EmptyState } from '@/components/EmptyState';

const STATUS_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'todo', label: 'To Do' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'in_review', label: 'In Review' },
  { id: 'done', label: 'Done' },
];

export default function ProjectDetailScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const [statusFilter, setStatusFilter] = useState('all');

  const projectQuery = useProject(projectId);
  const tasksQuery = useProjectTasks(
    projectId,
    useMemo(
      () => ({
        limit: 50,
        status: statusFilter === 'all' ? undefined : statusFilter,
      }),
      [statusFilter],
    ),
  );

  const project = projectQuery.data?.data;
  const tasks = tasksQuery.data?.data ?? [];

  if (projectQuery.isLoading) {
    return (
      <View style={[styles.loading, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color="#6366F1" />
      </View>
    );
  }

  if (!project) {
    return (
      <View style={[styles.loading, { backgroundColor: colors.background }]}>
        <Text style={{ color: colors.text }}>Project not found</Text>
      </View>
    );
  }

  const progressNum = Number(project.progress ?? 0);
  const color = project.color || '#6366F1';

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <ChevronLeft size={28} color={colors.text} />
        </TouchableOpacity>
      </View>

      <View style={styles.header}>
        <View style={styles.titleRow}>
          <View style={[styles.colorDot, { backgroundColor: color }]} />
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>
            {project.name}
          </Text>
        </View>
        <StatusBadge status={project.status} />
        {project.description ? (
          <Text style={[styles.description, { color: colors.muted }]} numberOfLines={3}>
            {project.description}
          </Text>
        ) : null}

        <View style={styles.statsRow}>
          <View style={styles.stat}>
            <Text style={[styles.statValue, { color: colors.text }]}>{project.totalTasks}</Text>
            <Text style={[styles.statLabel, { color: colors.muted }]}>Total</Text>
          </View>
          <View style={styles.stat}>
            <Text style={[styles.statValue, { color: colors.text }]}>{project.openTasks}</Text>
            <Text style={[styles.statLabel, { color: colors.muted }]}>Open</Text>
          </View>
          <View style={styles.stat}>
            <Text style={[styles.statValue, { color: colors.text }]}>{project.completedTasks}</Text>
            <Text style={[styles.statLabel, { color: colors.muted }]}>Done</Text>
          </View>
          <View style={styles.stat}>
            <Text style={[styles.statValue, { color: colors.text }]}>{progressNum.toFixed(0)}%</Text>
            <Text style={[styles.statLabel, { color: colors.muted }]}>Progress</Text>
          </View>
        </View>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filterScroll}
        contentContainerStyle={styles.filterRow}
      >
        {STATUS_FILTERS.map((f) => {
          const active = statusFilter === f.id;
          return (
            <TouchableOpacity
              key={f.id}
              onPress={() => setStatusFilter(f.id)}
              style={[
                styles.filterChip,
                {
                  backgroundColor: active ? '#6366F1' : colors.cardBackground,
                  borderColor: active ? '#6366F1' : colors.divider,
                },
              ]}
            >
              <Text style={[styles.filterLabel, { color: active ? '#fff' : colors.text }]}>{f.label}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <FlatList
        data={tasks}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <TaskCard
            task={item}
            onPress={() => router.push(`/task/${projectId}/${item.id}`)}
          />
        )}
        contentContainerStyle={[styles.listContent, tasks.length === 0 && { flex: 1 }]}
        refreshControl={
          <RefreshControl
            refreshing={tasksQuery.isRefetching}
            onRefresh={tasksQuery.refetch}
            tintColor="#6366F1"
          />
        }
        ListEmptyComponent={
          <EmptyState
            icon={<CheckSquare size={48} color={colors.muted} />}
            title="No tasks"
            description="This project has no tasks matching the selected filter."
          />
        }
      />

      <TouchableOpacity
        style={[styles.fab, { bottom: insets.bottom + 20 }]}
        onPress={() => router.push(`/task/new/${projectId}`)}
        activeOpacity={0.85}
      >
        <Plus size={26} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  topBar: { paddingHorizontal: 8, paddingVertical: 4 },
  backBtn: { padding: 4 },
  header: { paddingHorizontal: 16, paddingBottom: 12, gap: 10 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  colorDot: { width: 12, height: 12, borderRadius: 6 },
  title: { fontSize: 26, fontWeight: '700', flex: 1 },
  description: { fontSize: 14, lineHeight: 20 },
  statsRow: { flexDirection: 'row', gap: 16, paddingTop: 4 },
  stat: { alignItems: 'center', flex: 1 },
  statValue: { fontSize: 20, fontWeight: '700' },
  statLabel: { fontSize: 11, fontWeight: '500', textTransform: 'uppercase', letterSpacing: 0.3 },
  filterScroll: { flexGrow: 0, flexShrink: 0 },
  filterRow: { paddingHorizontal: 16, gap: 8, paddingVertical: 8, alignItems: 'center' },
  filterChip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, borderWidth: 0.5 },
  filterLabel: { fontSize: 13, fontWeight: '600' },
  listContent: { padding: 16, paddingTop: 8, paddingBottom: 96 },
  fab: {
    position: 'absolute',
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#6366F1',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 6,
  },
});
