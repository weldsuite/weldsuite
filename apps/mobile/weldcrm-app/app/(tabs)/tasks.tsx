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
import { Calendar, Check, Plus } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { TabHeader } from '@/components/headers';
import { TASK_STATUS_COLORS, TaskSheet, type TaskSheetMode } from '@/components/task-sheet';
import { usePagedList } from '@/hooks/use-paged-list';
import { api, type CrmTask } from '@/services/api';
import { interpolate, useI18n } from '@/lib/i18n';
import { TASK_STATUSES, initialsOf, type TaskStatus } from '@/lib/crm';
import { formatDueLabel, isOverdue, parseDate } from '@/lib/dates';
import { TASK_SECTION_ORDER, groupTasks, matchesTaskFilters } from '@/lib/task-groups';

type ThemeColors = ReturnType<typeof useTheme>['colors'];

const PAGE_SIZE = 100;
/** Load the next page when the list is this close to its end. */
const LOAD_MORE_DISTANCE = 400;

interface TaskItemProps {
  task: CrmTask;
  colors: ThemeColors;
  onPress: (task: CrmTask) => void;
  onToggle: (task: CrmTask) => void;
}

function TaskItem({ task, colors, onPress, onToggle }: Readonly<TaskItemProps>) {
  const { t, intlLocale } = useI18n();
  const dueDate = parseDate(task.dueDate);
  const overdue = !!dueDate && !task.completed && isOverdue(dueDate);
  const statusColors = TASK_STATUS_COLORS[task.status];

  return (
    <TouchableOpacity
      style={styles.taskItem}
      activeOpacity={0.7}
      onPress={() => onPress(task)}
      accessibilityRole="button"
      accessibilityLabel={task.title}
    >
      <View style={styles.taskRow}>
        <TouchableOpacity
          onPress={() => onToggle(task)}
          hitSlop={8}
          style={[
            styles.checkbox,
            {
              borderColor: task.completed ? '#8B5CF6' : colors.divider,
              backgroundColor: task.completed ? '#8B5CF6' : 'transparent',
            },
          ]}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: task.completed }}
          accessibilityLabel={task.completed ? t.tasks.markNotDone : t.tasks.markDone}
        >
          {task.completed && <Check size={16} color="#FFFFFF" strokeWidth={2.5} />}
        </TouchableOpacity>

        <View style={styles.taskContent}>
          <Text
            style={[styles.taskTitle, { color: colors.text }, task.completed && styles.taskTitleCompleted]}
            numberOfLines={1}
          >
            {task.title}
          </Text>

          <View style={styles.taskMeta}>
            <View style={[styles.statusBadge, { backgroundColor: statusColors.bgColor }]}>
              <Text style={[styles.statusText, { color: statusColors.color }]}>{t.tasks.status[task.status]}</Text>
            </View>

            {!!task.linkedCompany && (
              <View style={styles.companyBadge}>
                <View style={[styles.companyDot, { backgroundColor: task.linkedCompany.color || '#6B7280' }]} />
                <Text style={[styles.companyText, { color: colors.muted }]}>{task.linkedCompany.name}</Text>
              </View>
            )}

            {!!dueDate && (
              <View style={styles.dueDateBadge}>
                <Calendar size={11} color={overdue ? '#EF4444' : colors.muted} strokeWidth={2} />
                <Text style={[styles.dueDateText, { color: overdue ? '#EF4444' : colors.muted }]}>
                  {formatDueLabel(dueDate, t, intlLocale)}
                </Text>
              </View>
            )}

            {!!task.assignee && (
              <View style={[styles.avatar, { backgroundColor: colors.secondary }]}>
                <Text style={styles.avatarText}>{initialsOf(task.assignee.name)}</Text>
              </View>
            )}
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
}

export default function TasksScreen() {
  const { colors } = useTheme();
  const { t } = useI18n();
  const toast = useToast();
  const params = useLocalSearchParams<{ new?: string }>();

  const [searchTerm, setSearchTerm] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<TaskStatus | null>(null);
  const [sheet, setSheet] = useState<{ visible: boolean; mode: TaskSheetMode; task: CrmTask | null }>({
    visible: false,
    mode: 'view',
    task: null,
  });

  const fetchTasks = useCallback(
    (page: { cursor: string | null; search: string }) => api.getCrmTasks({ ...page, limit: PAGE_SIZE }),
    [],
  );
  const list = usePagedList<CrmTask>(fetchTasks, { search: searchTerm });

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
    const next = !task.completed;
    // Optimistic update, reverted if the API refuses.
    list.updateItem({ ...task, completed: next, status: next ? 'done' : 'todo' });
    const res = await api.updateCrmTask(task.id, { completed: next });
    if (res.success && res.data) {
      list.updateItem(res.data);
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
    })),
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
      />

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
                  <TaskItem key={task.id} task={task} colors={colors} onPress={openTask} onToggle={(item) => void toggleTask(item)} />
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
  taskItem: { borderRadius: 8, paddingVertical: 10 },
  taskRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  checkbox: { width: 20, height: 20, borderRadius: 5, borderWidth: 1.25, justifyContent: 'center', alignItems: 'center', marginTop: -1 },
  taskContent: { flex: 1, gap: 6 },
  taskTitle: { fontSize: 14, fontWeight: '500' },
  taskTitleCompleted: { textDecorationLine: 'line-through', opacity: 0.5 },
  taskMeta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  companyBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  companyDot: { width: 8, height: 8, borderRadius: 2 },
  companyText: { fontSize: 11 },
  statusBadge: { paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4 },
  statusText: { fontSize: 10, fontWeight: '600' },
  dueDateBadge: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  dueDateText: { fontSize: 11 },
  avatar: { width: 20, height: 20, borderRadius: 4, justifyContent: 'center', alignItems: 'center' },
  avatarText: { fontSize: 8, fontWeight: '600', color: '#6B7280' },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 80, paddingHorizontal: 40 },
  emptyCheckbox: { width: 64, height: 64, borderRadius: 8, borderWidth: 2, justifyContent: 'center', alignItems: 'center' },
  emptyTitle: { fontSize: 16, fontWeight: '600', marginTop: 16, marginBottom: 8 },
  emptyText: { fontSize: 13, textAlign: 'center' },
});
