/**
 * My Tasks — search and status filter over `GET /api/my-tasks`.
 *
 * Plus action opens a project picker so the create flow stays project-scoped
 * (app-api create lives at `POST /tasks/projects/:projectId`).
 */

import { useCallback, useMemo, useState } from 'react';
import {
  View,
  FlatList,
  RefreshControl,
  StyleSheet,
  Modal,
  Pressable,
  Text,
  ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { CheckSquare, Plus } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { SearchBar } from '@weldsuite/mobile-ui/components/SearchBar';
import { Chip } from '@weldsuite/mobile-ui/components/Chip';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';
import { Spinner } from '@weldsuite/mobile-ui/components/Spinner';

import { ACCENTS, BRAND } from '@/lib/brand';
import { formatShortDate, isTaskOverdue } from '@/lib/date';
import { Screen, ScreenHeader } from '@/components/screen';
import { RecordRow } from '@/components/record-row';
import { ColorSwatch, IconTile } from '@/components/detail';
import { ListSkeleton, ErrorState } from '@/components/data-states';
import { ProjectStatusBadge, TaskStatusBadge } from '@/components/status-badge';
import { useMyTasks, useProjects } from '@/hooks/use-weldflow';
import { useI18n } from '@/lib/i18n';

export default function MyTasksScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t, format } = useI18n();
  const [statusFilter, setStatusFilter] = useState('open');
  const [search, setSearch] = useState('');
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);

  const FILTERS = [
    { key: 'open', label: t.myTasks.filterOpen },
    { key: 'todo', label: t.myTasks.filterTodo },
    { key: 'in_progress', label: t.myTasks.filterInProgress },
    { key: 'in_review', label: t.myTasks.filterInReview },
    { key: 'done', label: t.myTasks.filterDone },
  ];

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

  const { data, isLoading, isError, isRefetching, refetch } = useMyTasks(params);

  const tasks = useMemo(() => {
    const raw = data?.data ?? [];
    if (statusFilter !== 'open') return raw;
    return raw.filter((task) => task.status !== 'done' && task.status !== 'cancelled');
  }, [data, statusFilter]);

  const open = useCallback(
    (route: string) => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      router.push(route as never);
    },
    [router],
  );

  const header = (
    <ScreenHeader
      title={t.myTasks.title}
      actions={
        <IconButton
          icon={<Plus size={22} color={colors.text} />}
          accessibilityLabel={t.myTasks.newTask}
          onPress={() => setProjectPickerOpen(true)}
        />
      }
      below={
        <View style={styles.controls}>
          <SearchBar
            value={search}
            onChangeText={setSearch}
            placeholder={t.myTasks.searchPlaceholder}
            containerStyle={styles.search}
          />
          <View style={styles.chips}>
            {FILTERS.map((f) => (
              <Chip
                key={f.key}
                label={f.label}
                selected={statusFilter === f.key}
                onPress={() => setStatusFilter(f.key)}
              />
            ))}
          </View>
        </View>
      }
    />
  );

  if (isLoading) {
    return (
      <Screen header={header}>
        <ListSkeleton />
      </Screen>
    );
  }

  if (isError && tasks.length === 0) {
    return (
      <Screen header={header}>
        <ErrorState message={t.myTasks.loadError} onRetry={() => void refetch()} />
      </Screen>
    );
  }

  return (
    <Screen header={header}>
      <FlatList
        data={tasks}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => {
          const overdue = isTaskOverdue(item.dueDate, item.status);
          const projectName = item.project?.name;
          return (
            <RecordRow
              leading={<IconTile icon={CheckSquare} color={ACCENTS.tasks} />}
              title={item.title}
              subtitle={projectName}
              meta={
                item.dueDate
                  ? format(t.common.dueOn, { date: formatShortDate(item.dueDate) })
                  : undefined
              }
              metaColor={overdue ? colors.destructive : undefined}
              badge={<TaskStatusBadge status={item.status} />}
              onPress={() => {
                if (item.projectId) open(`/task/${item.projectId}/${item.id}`);
              }}
            />
          );
        }}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={BRAND} />
        }
        contentContainerStyle={tasks.length === 0 ? styles.emptyContainer : undefined}
        ListEmptyComponent={
          <EmptyState
            icon={<CheckSquare size={32} color={colors.mutedForeground} />}
            title={t.myTasks.emptyTitle}
            description={t.myTasks.emptyDescription}
          />
        }
      />

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
              <Text style={[styles.modalTitle, { color: colors.text }]}>{t.myTasks.pickProject}</Text>
              <Pressable onPress={() => setProjectPickerOpen(false)}>
                <Text style={[styles.sheetAction, { color: BRAND }]}>{t.common.cancel}</Text>
              </Pressable>
            </View>
            {projectsQuery.isLoading ? (
              <View style={{ marginTop: 16 }}>
                <Spinner />
              </View>
            ) : projects.length === 0 ? (
              <Text style={[styles.emptyState, { color: colors.mutedForeground }]}>
                {t.myTasks.noProjects}
              </Text>
            ) : (
              <ScrollView>
                {projects.map((project) => (
                  <Pressable
                    key={project.id}
                    style={({ pressed }) => [
                      styles.projectRow,
                      { borderBottomColor: colors.border },
                      pressed && { backgroundColor: colors.pressed },
                    ]}
                    onPress={() => {
                      setProjectPickerOpen(false);
                      open(`/task/new/${project.id}`);
                    }}
                  >
                    <ColorSwatch color={project.color || BRAND} size={32} />
                    <View style={styles.projectInfo}>
                      <Text style={[styles.projectName, { color: colors.text }]} numberOfLines={1}>
                        {project.name}
                      </Text>
                      {project.code ? (
                        <Text style={[styles.projectCode, { color: colors.mutedForeground }]}>
                          {project.code}
                        </Text>
                      ) : null}
                    </View>
                    <ProjectStatusBadge status={project.status} />
                  </Pressable>
                ))}
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  controls: { gap: 10 },
  search: { borderRadius: 12 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  emptyContainer: { flexGrow: 1 },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' },
  modalSheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 16, maxHeight: '75%' },
  modalTitle: { fontSize: 18, fontWeight: '700' },
  sheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 12,
  },
  sheetAction: { fontSize: 16, fontWeight: '600' },
  projectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  projectInfo: { flex: 1, minWidth: 0 },
  projectName: { fontSize: 15, fontWeight: '600' },
  projectCode: { fontSize: 12, fontWeight: '500', marginTop: 2 },
  emptyState: { fontSize: 14, textAlign: 'center', paddingVertical: 32 },
});
