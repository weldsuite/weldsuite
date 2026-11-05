/**
 * A project's whiteboards (WeldBoard boards, `GET /api/boards?projectId=`).
 * Read only on the phone: a board opens in the viewer (`/board/:id`).
 */

import { FlatList, RefreshControl, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Presentation } from 'lucide-react-native';

import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';

import { ACCENTS, BRAND } from '@/lib/brand';
import { formatDate } from '@/lib/date';
import { Screen, ScreenHeader } from '@/components/screen';
import { RecordRow } from '@/components/record-row';
import { IconTile } from '@/components/detail';
import { ErrorState, ListSkeleton } from '@/components/data-states';
import { useProject, useProjectBoards } from '@/hooks/use-weldflow';
import { useI18n } from '@/lib/i18n';

export default function ProjectBoardsScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const { t, format } = useI18n();
  const project = useProject(projectId).data?.data;
  const boards = useProjectBoards(projectId);
  const rows = boards.data?.data ?? [];

  const header = <ScreenHeader title={t.boards.title} subtitle={project?.name} showBack />;
  if (boards.isLoading) {
    return (
      <Screen header={header}>
        <ListSkeleton count={4} />
      </Screen>
    );
  }
  if (boards.isError) {
    return (
      <Screen header={header}>
        <ErrorState message={t.boards.loadError} onRetry={() => void boards.refetch()} />
      </Screen>
    );
  }

  return (
    <Screen header={header}>
      <FlatList
        data={rows}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <RecordRow
            testID="project-board-row"
            leading={<IconTile icon={Presentation} color={ACCENTS.projects} />}
            title={item.name}
            meta={format(t.boards.updated, { date: formatDate(item.updatedAt) })}
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              router.push({ pathname: '/board/[boardId]', params: { boardId: item.id, name: item.name, legacy: item.legacy ? '1' : '0' } });
            }}
          />
        )}
        refreshControl={<RefreshControl refreshing={boards.isRefetching} onRefresh={() => void boards.refetch()} tintColor={BRAND} />}
        contentContainerStyle={rows.length === 0 ? styles.emptyContainer : undefined}
        ListEmptyComponent={
          <EmptyState
            icon={<Presentation size={32} color={colors.mutedForeground} />}
            title={t.boards.emptyTitle}
            description={t.boards.emptyDescription}
          />
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  emptyContainer: { flexGrow: 1 },
});
