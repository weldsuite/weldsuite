import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { CheckSquare, Plus } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { Chip } from '@weldsuite/mobile-ui/components/Chip';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';
import { SearchBar } from '@weldsuite/mobile-ui/components/SearchBar';
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
          <IconButton
            icon={<Plus size={22} color={colors.text} />}
            accessibilityLabel={t.tasks.add}
            onPress={() => setSheet({ visible: true, mode: 'create', task: null })}
          />
        }
      >
        <SearchBar value={searchTerm} onChangeText={setSearchTerm} placeholder={t.tasks.search} containerStyle={styles.search} />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          <Chip label={t.tasks.scopeMine} selected={scope === 'mine'} onPress={() => setScope('mine')} />
          <Chip label={t.tasks.scopeAll} selected={scope === 'all'} onPress={() => setScope('all')} />
          <View style={[styles.chipDivider, { backgroundColor: colors.border }]} />
          {statusOptions.map((item) => (
            <Chip
              key={item.key ?? 'all'}
              label={`${item.label} ${item.count}`}
              selected={selectedStatus === item.key}
              onPress={() => setSelectedStatus(item.key)}
            />
          ))}
        </ScrollView>
      </TabHeader>

      {list.loading ? (
        <ActivityIndicator style={styles.loading} size="large" color={colors.text} accessibilityLabel={t.tasks.loading} />
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
                <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
                  {`${t.tasks.sections[key]} · ${groups[key].length}`}
                </Text>
                {groups[key].map((task) => (
                  <TaskItem key={task.id} task={task} onPress={openTask} onToggle={(item) => void toggleTask(item)} />
                ))}
              </View>
            ),
          )}

          {list.loadingMore && <ActivityIndicator style={styles.footerSpinner} color={colors.text} />}

          {filteredTasks.length === 0 && (
            <EmptyState
              icon={<CheckSquare size={32} color={colors.mutedForeground} />}
              title={list.error ? t.tasks.loadFailed : t.tasks.emptyTitle}
              description={list.error ? t.common.pullToRetry : t.tasks.emptyText}
            />
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
  loading: { marginTop: 48 },
  search: { borderRadius: 12 },
  chips: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chipDivider: { width: StyleSheet.hairlineWidth, height: 20, marginHorizontal: 2 },
  scrollView: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 20, flexGrow: 1 },
  footerSpinner: { paddingVertical: 16 },
  section: { marginBottom: 16 },
  sectionLabel: { fontSize: 13, fontWeight: '600', marginTop: 12, marginBottom: 4 },
});
