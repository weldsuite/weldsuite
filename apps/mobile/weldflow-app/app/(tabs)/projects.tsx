/**
 * Projects list — search, status filter over `GET /api/projects`.
 *
 * Full-bleed RecordRows match the WeldBooks list pattern; the floating tab bar
 * is the chrome, not a stack of cards.
 */

import { useCallback, useMemo, useState } from 'react';
import { View, FlatList, RefreshControl, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { FolderKanban } from 'lucide-react-native';

import { SearchBar } from '@weldsuite/mobile-ui/components/SearchBar';
import { Chip } from '@weldsuite/mobile-ui/components/Chip';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { BRAND } from '@/lib/brand';
import { formatDate } from '@/lib/date';
import { Screen, ScreenHeader } from '@/components/screen';
import { RecordRow } from '@/components/record-row';
import { ColorSwatch } from '@/components/detail';
import { ListSkeleton, ErrorState } from '@/components/data-states';
import { ProjectStatusBadge } from '@/components/status-badge';
import { useProjects } from '@/hooks/use-weldflow';
import { useI18n } from '@/lib/i18n';

export default function ProjectsScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { t, format } = useI18n();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const FILTERS = [
    { key: 'all', label: t.projects.filterAll },
    { key: 'Planning', label: t.projects.filterPlanning },
    { key: 'Active', label: t.projects.filterActive },
    { key: 'OnHold', label: t.projects.filterOnHold },
    { key: 'Completed', label: t.projects.filterCompleted },
  ];

  const params = useMemo(
    () => ({
      limit: 25,
      search: search.trim() || undefined,
      status: statusFilter === 'all' ? undefined : statusFilter,
    }),
    [search, statusFilter],
  );

  const { data, isLoading, isError, isRefetching, refetch } = useProjects(params);
  const projects = data?.data ?? [];

  const open = useCallback(
    (route: string) => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      router.push(route as never);
    },
    [router],
  );

  const header = (
    <ScreenHeader
      title={t.projects.title}
      below={
        <View style={styles.controls}>
          <SearchBar
            value={search}
            onChangeText={setSearch}
            placeholder={t.projects.searchPlaceholder}
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

  if (isError && projects.length === 0) {
    return (
      <Screen header={header}>
        <ErrorState message={t.projects.loadError} onRetry={() => void refetch()} />
      </Screen>
    );
  }

  return (
    <Screen header={header}>
      <FlatList
        data={projects}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => {
          const progress = Number(item.progress ?? 0);
          return (
            <RecordRow
              leading={<ColorSwatch color={item.color || BRAND} />}
              title={item.name}
              subtitle={item.code || undefined}
              meta={
                item.endDate
                  ? format(t.common.dueOn, { date: formatDate(item.endDate) })
                  : format(t.common.tasksDone, {
                      done: item.completedTasks ?? 0,
                      total: item.totalTasks ?? 0,
                    })
              }
              amount={format(t.common.progressPct, { value: progress.toFixed(0) })}
              badge={<ProjectStatusBadge status={item.status} />}
              onPress={() => open(`/project/${item.id}`)}
            />
          );
        }}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} tintColor={BRAND} />
        }
        contentContainerStyle={projects.length === 0 ? styles.emptyContainer : undefined}
        ListEmptyComponent={
          <EmptyState
            icon={<FolderKanban size={32} color={colors.mutedForeground} />}
            title={t.projects.emptyTitle}
            description={t.projects.emptyDescription}
          />
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  controls: { gap: 10 },
  search: { borderRadius: 12 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  emptyContainer: { flexGrow: 1 },
});
