/**
 * Project detail — stats strip + filtered task list from app-api
 * (`GET /projects/:id`, `GET /tasks?projectId=`).
 */

import { useMemo, useState } from 'react';
import { View, FlatList, RefreshControl, StyleSheet, Text } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { CheckSquare, Plus } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Chip } from '@weldsuite/mobile-ui/components/Chip';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { IconButton } from '@weldsuite/mobile-ui/components/IconButton';

import { ACCENTS, BRAND } from '@/lib/brand';
import { formatShortDate, isTaskOverdue } from '@/lib/date';
import { Screen, ScreenHeader } from '@/components/screen';
import { RecordRow } from '@/components/record-row';
import { IconTile } from '@/components/detail';
import { DetailSkeleton, ErrorState, ListSkeleton } from '@/components/data-states';
import { ProjectStatusBadge, TaskStatusBadge } from '@/components/status-badge';
import { useProject, useProjectTasks } from '@/hooks/use-weldflow';
import { useI18n } from '@/lib/i18n';

export default function ProjectDetailScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const { t, format } = useI18n();
  const [statusFilter, setStatusFilter] = useState('all');

  const FILTERS = [
    { key: 'all', label: t.common.all },
    { key: 'todo', label: t.myTasks.filterTodo },
    { key: 'in_progress', label: t.myTasks.filterInProgress },
    { key: 'in_review', label: t.myTasks.filterInReview },
    { key: 'done', label: t.myTasks.filterDone },
  ];

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
      <Screen header={<ScreenHeader title={t.projects.title} showBack />}>
        <DetailSkeleton />
      </Screen>
    );
  }

  if (!project) {
    return (
      <Screen header={<ScreenHeader title={t.projects.title} showBack />}>
        <ErrorState
          message={t.projects.notFound}
          onRetry={() => void projectQuery.refetch()}
        />
      </Screen>
    );
  }

  const progressNum = Number(project.progress ?? 0);
  const color = project.color || BRAND;

  const header = (
    <ScreenHeader
      title={project.name}
      subtitle={project.code || undefined}
      showBack
      actions={
        <IconButton
          icon={<Plus size={22} color={colors.text} />}
          accessibilityLabel={t.projects.newTask}
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            router.push(`/task/new/${projectId}`);
          }}
        />
      }
      below={
        <View style={styles.below}>
          <View style={styles.badgeRow}>
            <View style={[styles.dot, { backgroundColor: color }]} />
            <ProjectStatusBadge status={project.status} />
          </View>
          {project.description ? (
            <Text style={[styles.description, { color: colors.mutedForeground }]} numberOfLines={3}>
              {project.description}
            </Text>
          ) : null}
          <View style={styles.statsRow}>
            <Stat label={t.projects.total} value={String(project.totalTasks ?? 0)} />
            <Stat label={t.projects.open} value={String(project.openTasks ?? 0)} />
            <Stat label={t.projects.completed} value={String(project.completedTasks ?? 0)} />
            <Stat label={t.projects.progress} value={`${progressNum.toFixed(0)}%`} />
          </View>
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

  return (
    <Screen header={header}>
      {tasksQuery.isLoading ? (
        <ListSkeleton count={4} />
      ) : (
        <FlatList
          data={tasks}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => {
            const overdue = isTaskOverdue(item.dueDate, item.status);
            return (
              <RecordRow
                leading={<IconTile icon={CheckSquare} color={ACCENTS.tasks} />}
                title={item.title}
                meta={
                  item.dueDate
                    ? format(t.common.dueOn, { date: formatShortDate(item.dueDate) })
                    : undefined
                }
                metaColor={overdue ? colors.destructive : undefined}
                badge={<TaskStatusBadge status={item.status} />}
                onPress={() => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  router.push(`/task/${projectId}/${item.id}`);
                }}
              />
            );
          }}
          refreshControl={
            <RefreshControl
              refreshing={tasksQuery.isRefetching}
              onRefresh={() => void tasksQuery.refetch()}
              tintColor={BRAND}
            />
          }
          contentContainerStyle={tasks.length === 0 ? styles.emptyContainer : undefined}
          ListEmptyComponent={
            <EmptyState
              icon={<CheckSquare size={32} color={colors.mutedForeground} />}
              title={t.projects.noTasksTitle}
              description={t.projects.noTasksDescription}
            />
          }
        />
      )}
    </Screen>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, { color: colors.text }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  below: { gap: 12 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  description: { fontSize: 14, lineHeight: 20 },
  statsRow: { flexDirection: 'row', gap: 8 },
  stat: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 12,
  },
  statValue: { fontSize: 18, fontWeight: '700', letterSpacing: -0.3 },
  statLabel: { fontSize: 11, fontWeight: '600', marginTop: 2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  emptyContainer: { flexGrow: 1 },
});
