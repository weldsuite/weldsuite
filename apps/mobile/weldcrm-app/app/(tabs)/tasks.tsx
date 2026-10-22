import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Check, Plus } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { SegmentedControl } from '@weldsuite/mobile-ui/components/SegmentedControl';
import { TabHeader } from '@/components/headers';
import { TaskItem } from '@/components/task-item';
import { TaskSheet, type TaskSheetMode } from '@/components/task-sheet';
import { usePagedList } from '@/hooks/use-paged-list';
import { tasksApi, type CrmTask } from '@/services/tasks';
import { interpolate, useI18n } from '@/lib/i18n';
import { TASK_STATUSES, type TaskStatus } from '@/lib/crm';
import { TASK_SECTION_ORDER, groupTasks, matchesTaskFilters } from '@/lib/task-groups';

type Scope = 'mine' | 'all';

const PAGE_SIZE = 100;
/** Load the next page when the list is this close to its end. */
const LOAD_MORE_DISTANCE = 400;

export default function TasksScreen() {
  const { colors } = useTheme();
  const { t } = useI18n();
  const toast = useToast();
  const { user } = useClerkAuth();
  const params = useLocalSearchParams<{ new?: string }>();

  const [searchTerm, setSearchTerm] = useState('');
  const [scope, setScope] = useState<Scope>('mine');
  const [selectedStatus, setSelectedStatus] = useState<TaskStatus | null>(null);
  const [sheet, setSheet] = useState<{ visible: boolean; mode: TaskSheetMode; task: CrmTask | null }>({
    visible: false,
    mode: 'view',
    task: null,
  });

  const userId = user?.id;
  const fetchTasks = useCallback(
    (page: { cursor: string | null; search: string }) =>
      tasksApi.list({ ...page, limit: PAGE_SIZE, assigneeId: scope === 'mine' ? userId : undefined }),
    [scope, userId],
  );
  const list = usePagedList<CrmTask>(fetchTasks, { search: searchTerm, resetKey: `${scope}:${userId ?? ''}` });

  useEffect(() => {
    if (list.error) toast.error(t.tasks.loadFailed);
  }, [list.error, t, toast]);

  // Home's "New Task" lands here with ?new=1.
  useEffect(() => {
    if (params.new !== '1') return;
    router.setParams({ new: undefined });
    setSheet({ visible: true, mode: 'create', task: null });
  }, [params.new]);

  const tasks = list.items;
  const filteredTasks = tasks.filter((task) => matchesTaskFilters(task, searchTerm, selectedStatus));
  const groups = groupTasks(filteredTasks);

  const toggleTask = async (task: CrmTask) => {
    const next: TaskStatus = task.completed ? 'todo' : 'done';
    // Optimistic update, reverted if the API refuses.
    list.updateItem({ ...task, completed: next === 'done', status: next });
    const res = await tasksApi.update(task.id, { status: next });
    if (res.success && res.data) {
      list.updateItem(res.data);
      // Completing a repeating task makes the next one; pick it up.
      if (next === 'done' && task.repeat) void list.refresh();
    } else {
      list.updateItem(task);
      toast.error(t.tasks.updateFailed);
    }
  };

  const openTask = (task: CrmTask) => setSheet({ visible: true, mode: 'view', task });
  const closeSheet = () => setSheet((prev) => ({ ...prev, visible: false }));

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
    if (contentOffset.y + layoutMeasurement.height >= contentSize.height - LOAD_MORE_DISTANCE) {
      void list.loadMore();
    }
  };

  const statusOptions: { key: TaskStatus | null; label: string; count: number }[] = [
    { key: null, label: t.tasks.filterAll, count: tasks.length },
    ...TASK_STATUSES.map((status) => ({
      key: status,
      label: t.tasks.status[status],
      count: tasks.filter((task) => task.status === status).length,
    })).filter((option) => option.count > 0 || option.key === selectedStatus),
  ];

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <TabHeader
        title={interpolate(t.tasks.titleWithCount, { count: filteredTasks.length })}
        right={
          <TouchableOpacity
            style={[styles.addButton, { borderColor: colors.buttonBorder }]}
            onPress={() => setSheet({ visible: true, mode: 'create', task: null })}
            accessibilityRole="button"
            accessibilityLabel={t.tasks.add}
          >
            <Plus size={16} color={colors.text} strokeWidth={2} />
            <Text style={[styles.addButtonText, { color: colors.text }]}>{t.tasks.add}</Text>
          </TouchableOpacity>
        }
      >
        <SegmentedControl
          options={[
            { value: 'mine', label: t.tasks.scopeMine },
            { value: 'all', label: t.tasks.scopeAll },
          ]}
          value={scope}
          onValueChange={(value) => setScope(value as Scope)}
          style={styles.segments}
        />
      </TabHeader>

      <View style={styles.searchBarContainer}>
        <View style={[styles.searchBar, { backgroundColor: colors.inputBackground }]}>
          <Ionicons name="search" size={16} color={colors.muted} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder={t.tasks.search}
            placeholderTextColor={colors.muted}
            value={searchTerm}
            onChangeText={setSearchTerm}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
        </View>
      </View>

      <View style={styles.filterContainer}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterList}>
          {statusOptions.map((item) => {
            const selected = selectedStatus === item.key;
            return (
              <TouchableOpacity
                key={item.key ?? 'all'}
                style={[
                  styles.filterButton,
                  {
                    backgroundColor: selected ? colors.text : colors.background,
                    borderColor: selected ? colors.text : colors.buttonBorder,
                  },
                ]}
                onPress={() => setSelectedStatus(item.key)}
                accessibilityRole="button"
                accessibilityState={{ selected }}
              >
                <Text style={[styles.filterButtonText, { color: selected ? colors.background : colors.text }]}>
                  {item.label}
                </Text>
                <Text style={[styles.filterButtonCount, { color: selected ? colors.background : colors.muted }]}>
                  ({item.count})
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {list.loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.text} />
          <Text style={[styles.loadingText, { color: colors.muted }]}>{t.tasks.loading}</Text>
        </View>
      ) : (
        <ScrollView
          style={styles.scrollView}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scrollContent}
          onScroll={handleScroll}
          scrollEventThrottle={200}
          refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={() => void list.refresh()} />}
        >
          {TASK_SECTION_ORDER.map((key) =>
            groups[key].length === 0 ? null : (
              <View key={key} style={styles.section}>
                <View style={styles.sectionHeader}>
                  <Text style={[styles.sectionTitle, { color: colors.muted }]}>{t.tasks.sections[key]}</Text>
                  <View style={[styles.countBadge, { backgroundColor: colors.secondary }]}>
                    <Text style={[styles.countText, { color: colors.mutedForeground }]}>{groups[key].length}</Text>
                  </View>
                </View>
                {groups[key].map((task) => (
                  <TaskItem key={task.id} task={task} onPress={openTask} onToggle={(item) => void toggleTask(item)} />
                ))}
              </View>
            ),
          )}

          {list.loadingMore && <ActivityIndicator style={styles.footerSpinner} color={colors.text} />}

          {filteredTasks.length === 0 && (
            <View style={styles.emptyState}>
              <View style={[styles.emptyCheckbox, { borderColor: colors.divider }]}>
                <Check size={32} color={colors.muted} strokeWidth={1.5} />
              </View>
              <Text style={[styles.emptyTitle, { color: colors.text }]}>
                {list.error ? t.tasks.loadFailed : t.tasks.emptyTitle}
              </Text>
              <Text style={[styles.emptyText, { color: colors.muted }]}>
                {list.error ? t.common.pullToRetry : t.tasks.emptyText}
              </Text>
            </View>
          )}
        </ScrollView>
      )}

      <TaskSheet
        visible={sheet.visible}
        initialMode={sheet.mode}
        task={sheet.task}
        onClose={closeSheet}
        onCreated={(task) => {
          list.addItem(task);
          closeSheet();
        }}
        onUpdated={(task) => {
          list.updateItem(task);
          setSheet((prev) => (prev.task?.id === task.id ? { ...prev, task } : prev));
        }}
        onDeleted={(id) => {
          list.removeItem(id);
          closeSheet();
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { marginTop: 16, fontSize: 12 },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  addButtonText: { fontSize: 13, fontWeight: '500' },
  segments: { marginTop: 12 },
  searchBarContainer: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  searchBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, gap: 8 },
  searchInput: { flex: 1, fontSize: 14, fontWeight: '400', padding: 0 },
  filterContainer: { paddingTop: 4, paddingBottom: 12 },
  filterList: { flexDirection: 'row', gap: 8, paddingHorizontal: 16 },
  filterButton: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1, gap: 4 },
  filterButtonText: { fontSize: 13, fontWeight: '500' },
  filterButtonCount: { fontSize: 13, fontWeight: '400' },
  scrollView: { flex: 1 },
  scrollContent: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 20, flexGrow: 1 },
  footerSpinner: { paddingVertical: 16 },
  section: { marginBottom: 24 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  sectionTitle: { fontSize: 13, fontWeight: '600' },
  countBadge: { minWidth: 18, height: 18, paddingHorizontal: 4, borderRadius: 5, justifyContent: 'center', alignItems: 'center' },
  countText: { fontSize: 9, fontWeight: '600' },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 80, paddingHorizontal: 40 },
  emptyCheckbox: { width: 64, height: 64, borderRadius: 8, borderWidth: 2, justifyContent: 'center', alignItems: 'center' },
  emptyTitle: { fontSize: 16, fontWeight: '600', marginTop: 16, marginBottom: 8 },
  emptyText: { fontSize: 13, textAlign: 'center' },
});
