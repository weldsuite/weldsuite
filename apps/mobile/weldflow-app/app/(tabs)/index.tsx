/**
 * WeldFlow home — list-first dashboard matching the floating pill nav: a large
 * title, compact KPI strip, icon shortcuts, then recent projects and tasks as
 * full-bleed rows. Data comes from app-api (`/projects`, `/my-tasks`).
 */

import { useCallback, useEffect } from 'react';
import { View, Text, ScrollView, RefreshControl, StyleSheet, Pressable } from 'react-native';
import { useObserve } from 'expo-observe';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { FolderKanban, CheckSquare, Plus, Settings } from 'lucide-react-native';

import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { useOrganization } from '@clerk/expo';

import { ACCENTS, BRAND, tint } from '@/lib/brand';
import { formatShortDate, isTaskOverdue } from '@/lib/date';
import { Screen, ScreenHeader, SectionLabel } from '@/components/screen';
import { KpiCard, KpiGrid, KpiSkeletonGrid } from '@/components/kpi';
import { RecordRow } from '@/components/record-row';
import { ColorSwatch, IconTile } from '@/components/detail';
import { ErrorState } from '@/components/data-states';
import { ProjectStatusBadge, TaskStatusBadge } from '@/components/status-badge';
import { useProjects, useMyTasks } from '@/hooks/use-weldflow';
import { useI18n } from '@/lib/i18n';
import { hideAppSplash } from '@/utils/splash';

/** `excludeStatus` that leaves "open" tasks, i.e. everything not finished. */
const OPEN_EXCLUDED = 'done,cancelled';

export default function HomeScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { markInteractive } = useObserve();
  const { organization } = useOrganization();
  const { t, format, plural } = useI18n();

  // The KPIs are server totals (`pagination.totalCount`), not counts of what
  // happens to be loaded, so they stay right past the first page. The recent
  // lists reuse the same queries: a short first page plus the total.
  const projectsQuery = useProjects({ limit: 6, isActive: true });
  const tasksQuery = useMyTasks({ limit: 8, excludeStatus: OPEN_EXCLUDED });
  const allTasksQuery = useMyTasks({ limit: 1 });
  const overdueQuery = useMyTasks({
    limit: 1,
    excludeStatus: OPEN_EXCLUDED,
    dueDateBucket: 'overdue',
  });
  const doneQuery = useMyTasks({ limit: 1, status: 'done' });

  const projects = projectsQuery.data?.data ?? [];
  const openTasks = tasksQuery.data?.data ?? [];

  const activeProjectCount = projectsQuery.data?.pagination.totalCount ?? 0;
  const openTaskCount = tasksQuery.data?.pagination.totalCount ?? 0;
  const allTaskCount = allTasksQuery.data?.pagination.totalCount ?? 0;
  const overdueCount = overdueQuery.data?.pagination.totalCount ?? 0;
  const doneCount = doneQuery.data?.pagination.totalCount ?? 0;

  const queries = [projectsQuery, tasksQuery, allTasksQuery, overdueQuery, doneQuery];
  const loading = queries.some((q) => q.isLoading);
  const error = queries.some((q) => q.isError);
  const refreshing = queries.some((q) => q.isRefetching);

  useEffect(() => {
    if (!loading) {
      hideAppSplash();
      markInteractive();
    }
  }, [loading, markInteractive]);

  const onRefresh = useCallback(() => {
    void projectsQuery.refetch();
    void tasksQuery.refetch();
    void allTasksQuery.refetch();
    void overdueQuery.refetch();
    void doneQuery.refetch();
  }, [projectsQuery, tasksQuery, allTasksQuery, overdueQuery, doneQuery]);

  const navigate = useCallback(
    (route: string) => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      router.push(route as never);
    },
    [router],
  );

  const QUICK_ACTIONS = [
    { label: t.dashboard.projects, icon: FolderKanban, route: '/(tabs)/projects' },
    { label: t.dashboard.myTasks, icon: CheckSquare, route: '/(tabs)/my-tasks' },
    { label: t.dashboard.newTask, icon: Plus, route: '/(tabs)/my-tasks' },
    { label: t.dashboard.settings, icon: Settings, route: '/settings' },
  ] as const;

  const header = (
    <ScreenHeader title={organization?.name || t.dashboard.title} />
  );

  if (error && !projectsQuery.data && !tasksQuery.data) {
    return (
      <Screen header={header}>
        <ErrorState
          message={t.dashboard.loadError}
          onRetry={onRefresh}
        />
      </Screen>
    );
  }

  return (
    <Screen header={header}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={BRAND} />
        }
      >
        {loading ? (
          <KpiSkeletonGrid />
        ) : (
          <KpiGrid>
            <KpiCard
              label={t.dashboard.activeProjects}
              value={String(activeProjectCount)}
              sub={plural(activeProjectCount, t.dashboard.projectCount)}
              onPress={() => navigate('/(tabs)/projects')}
            />
            <KpiCard
              label={t.dashboard.openTasks}
              value={String(openTaskCount)}
              sub={plural(allTaskCount, t.dashboard.taskCount)}
              onPress={() => navigate('/(tabs)/my-tasks')}
            />
            <KpiCard
              label={t.dashboard.overdue}
              value={String(overdueCount)}
              warn={overdueCount > 0}
              onPress={() => navigate('/(tabs)/my-tasks')}
            />
            <KpiCard
              label={t.dashboard.done}
              value={String(doneCount)}
              sub={plural(doneCount, t.dashboard.taskCount)}
            />
          </KpiGrid>
        )}

        <View style={styles.actions}>
          {QUICK_ACTIONS.map(({ label, icon: Icon, route }) => (
            <Pressable
              key={label}
              onPress={() => navigate(route)}
              accessibilityRole="button"
              accessibilityLabel={label}
              style={({ pressed }) => [styles.action, pressed && styles.pressed]}
            >
              <View style={[styles.actionIcon, { backgroundColor: tint(BRAND) }]}>
                <Icon size={22} color={BRAND} strokeWidth={2.2} />
              </View>
              <Text style={[styles.actionLabel, { color: colors.mutedForeground }]} numberOfLines={1}>
                {label}
              </Text>
            </Pressable>
          ))}
        </View>

        <SectionLabel>{t.dashboard.recentProjects}</SectionLabel>
        {projects.length === 0 && !loading ? (
          <EmptyState
            icon={<FolderKanban size={32} color={colors.mutedForeground} />}
            title={t.dashboard.noProjectsTitle}
            description={t.dashboard.noProjectsDescription}
            style={styles.empty}
          />
        ) : (
          projects.map((project) => {
            const progress = Number(project.progress ?? 0);
            return (
              <RecordRow
                key={project.id}
                leading={<ColorSwatch color={project.color || BRAND} />}
                title={project.name}
                subtitle={project.code || undefined}
                meta={format(t.common.tasksDone, {
                  done: project.completedTasks ?? 0,
                  total: project.totalTasks ?? 0,
                })}
                amount={format(t.common.progressPct, { value: progress.toFixed(0) })}
                badge={<ProjectStatusBadge status={project.status} />}
                onPress={() => navigate(`/project/${project.id}`)}
              />
            );
          })
        )}

        <SectionLabel>{t.dashboard.recentTasks}</SectionLabel>
        {openTasks.length === 0 && !loading ? (
          <EmptyState
            icon={<CheckSquare size={32} color={colors.mutedForeground} />}
            title={t.dashboard.noTasksTitle}
            description={t.dashboard.noTasksDescription}
            style={styles.empty}
          />
        ) : (
          openTasks.map((task) => {
            const overdue = isTaskOverdue(task.dueDate, task.status);
            const projectName = 'project' in task && task.project ? task.project.name : undefined;
            return (
              <RecordRow
                key={task.id}
                leading={<IconTile icon={CheckSquare} color={ACCENTS.tasks} />}
                title={task.title}
                subtitle={projectName}
                meta={
                  task.dueDate
                    ? format(t.common.dueOn, { date: formatShortDate(task.dueDate) })
                    : undefined
                }
                metaColor={overdue ? colors.destructive : undefined}
                badge={<TaskStatusBadge status={task.status} />}
                onPress={() => {
                  if (task.projectId) navigate(`/task/${task.projectId}/${task.id}`);
                }}
              />
            );
          })
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: 8, paddingBottom: 16 },
  actions: {
    flexDirection: 'row',
    paddingHorizontal: 8,
    paddingTop: 20,
    paddingBottom: 4,
  },
  action: { flex: 1, alignItems: 'center', gap: 8 },
  pressed: { opacity: 0.7 },
  actionIcon: {
    width: 52,
    height: 52,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionLabel: { fontSize: 12, fontWeight: '600' },
  empty: { marginTop: 12, marginBottom: 8 },
});
