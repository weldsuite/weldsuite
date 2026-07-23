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
  TextInput,
  Modal,
  Pressable,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { CheckSquare, Search, Plus } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useMyTasks, useProjects } from '@/hooks/use-weldflow';
import { TaskCard } from '@/components/TaskCard';
import { EmptyState } from '@/components/EmptyState';
import { StatusBadge } from '@/components/StatusBadge';

const STATUS_FILTERS = [
  { id: 'open', label: 'Open' },
  { id: 'todo', label: 'To Do' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'in_review', label: 'In Review' },
  { id: 'done', label: 'Done' },
];

export default function MyTasksScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [statusFilter, setStatusFilter] = useState('open');
  const [search, setSearch] = useState('');
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);

  const projectsQuery = useProjects({ limit: 50, isActive: true });
  const projects = projectsQuery.data?.data ?? [];

  const params = useMemo(
    () => ({
      limit: 50,
      search: search.trim() || undefined,
      status: statusFilter === 'open' ? undefined : statusFilter,
    }),
    [statusFilter, search],
  );

  const { data, isLoading, isRefetching, refetch } = useMyTasks(params);

  const tasks = useMemo(() => {
    const raw = data?.data ?? [];
    if (statusFilter !== 'open') return raw;
    return raw.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
  }, [data, statusFilter]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>My Tasks</Text>
      </View>

      <View style={[styles.searchRow, { backgroundColor: colors.cardBackground, borderColor: colors.divider }]}>
        <Search size={18} color={colors.muted} />
        <TextInput
          style={[styles.searchInput, { color: colors.text }]}
          placeholder="Search tasks"
          placeholderTextColor={colors.muted}
          value={search}
          onChangeText={setSearch}
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
        />
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

      {isLoading ? (
        <ActivityIndicator style={{ marginTop: 32 }} size="large" color="#6366F1" />
      ) : (
        <FlatList
          data={tasks}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <TaskCard
              task={item}
              showProject
              onPress={() => {
                if (item.projectId) {
                  router.push(`/task/${item.projectId}/${item.id}`);
                }
              }}
            />
          )}
          contentContainerStyle={[styles.listContent, tasks.length === 0 && { flex: 1 }]}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor="#6366F1" />}
          ListEmptyComponent={
            <EmptyState
              icon={<CheckSquare size={48} color={colors.muted} />}
              title="No tasks assigned"
              description="Tasks assigned to you will show up here."
            />
          }
        />
      )}

      <TouchableOpacity
        style={[styles.fab, { bottom: insets.bottom + 20 }]}
        onPress={() => setProjectPickerOpen(true)}
        activeOpacity={0.85}
      >
        <Plus size={26} color="#fff" />
      </TouchableOpacity>

      <Modal
        visible={projectPickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setProjectPickerOpen(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setProjectPickerOpen(false)}>
          <Pressable
            style={[
              styles.modalSheet,
              { backgroundColor: colors.cardBackground, paddingBottom: insets.bottom + 16 },
            ]}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={styles.sheetHeader}>
              <Text style={[styles.modalTitle, { color: colors.text }]}>Pick a project</Text>
              <TouchableOpacity onPress={() => setProjectPickerOpen(false)}>
                <Text style={styles.sheetAction}>Cancel</Text>
              </TouchableOpacity>
            </View>
            {projectsQuery.isLoading ? (
              <ActivityIndicator style={{ marginTop: 16 }} color="#6366F1" />
            ) : projects.length === 0 ? (
              <Text style={[styles.emptyState, { color: colors.muted }]}>
                No active projects yet. Create one on the web first.
              </Text>
            ) : (
              <ScrollView>
                {projects.map((p) => (
                  <TouchableOpacity
                    key={p.id}
                    style={[styles.projectRow, { borderBottomColor: colors.divider }]}
                    onPress={() => {
                      setProjectPickerOpen(false);
                      router.push(`/task/new/${p.id}`);
                    }}
                  >
                    <View style={styles.projectRowLeft}>
                      <View style={[styles.projectDot, { backgroundColor: p.color || '#6366F1' }]} />
                      <View style={styles.projectInfo}>
                        <Text style={[styles.projectName, { color: colors.text }]} numberOfLines={1}>
                          {p.name}
                        </Text>
                        {p.code ? (
                          <Text style={[styles.projectCode, { color: colors.muted }]}>{p.code}</Text>
                        ) : null}
                      </View>
                    </View>
                    <StatusBadge status={p.status} />
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  headerTitle: { fontSize: 34, fontWeight: '700' },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginVertical: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 0.5,
  },
  searchInput: { flex: 1, fontSize: 15, padding: 0 },
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
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  modalSheet: { borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, maxHeight: '75%' },
  modalTitle: { fontSize: 18, fontWeight: '700' },
  sheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 12,
  },
  sheetAction: { fontSize: 16, fontWeight: '600', color: '#6366F1' },
  projectRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: 0.5,
    gap: 12,
  },
  projectRowLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  projectDot: { width: 10, height: 10, borderRadius: 5 },
  projectInfo: { flex: 1 },
  projectName: { fontSize: 15, fontWeight: '600' },
  projectCode: { fontSize: 12, fontWeight: '500' },
  emptyState: { fontSize: 14, textAlign: 'center', paddingVertical: 32 },
});
