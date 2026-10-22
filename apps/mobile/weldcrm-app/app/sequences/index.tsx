import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  View,
} from 'react-native';
import { Stack, router } from 'expo-router';
import { Workflow } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { SearchBar } from '@weldsuite/mobile-ui/components/SearchBar';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { StackHeader } from '@/components/headers';
import { Pill, RecordRow } from '@/components/record-row';
import { usePagedList } from '@/hooks/use-paged-list';
import { sequencesApi, type CrmSequence } from '@/services/sequences';
import { interpolate, labelFor, useI18n } from '@/lib/i18n';

const STATUS_COLORS: Record<string, string> = {
  draft: '#6B7280',
  active: '#10B981',
  paused: '#F59E0B',
  archived: '#9CA3AF',
};

const statusColor = (status: string) => STATUS_COLORS[status] ?? '#6B7280';

export default function SequencesScreen() {
  const { colors } = useTheme();
  const { t, plural, intlLocale } = useI18n();
  const toast = useToast();
  const [search, setSearch] = useState('');

  const fetchSequences = useCallback(
    (params: { cursor: string | null; search: string }) => sequencesApi.getSequences(params),
    [],
  );
  const sequences = usePagedList<CrmSequence>(fetchSequences, { search });

  useEffect(() => {
    if (sequences.error) toast.error(t.sequences.loadFailed);
  }, [sequences.error, t, toast]);

  const openSequence = (sequence: CrmSequence) => {
    router.push({ pathname: '/sequences/[id]', params: { id: sequence.id, name: sequence.name } });
  };

  const lastRunText = (sequence: CrmSequence) =>
    sequence.lastRunAt
      ? interpolate(t.sequences.lastRun, {
          date: new Date(sequence.lastRunAt).toLocaleDateString(intlLocale, {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          }),
        })
      : t.sequences.neverRun;

  const renderEmpty = () => {
    const icon = <Workflow size={32} color={colors.mutedForeground} />;
    if (sequences.loading) {
      return (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.text} />
        </View>
      );
    }
    if (sequences.error) {
      return <EmptyState icon={icon} title={t.sequences.loadFailed} description={t.common.pullToRetry} />;
    }
    return (
      <EmptyState
        icon={icon}
        title={search ? t.sequences.emptyFiltered : t.sequences.empty}
        description={search ? undefined : t.sequences.emptyHint}
      />
    );
  };

  const renderItem = ({ item }: { item: CrmSequence }) => {
    const statusLabel = labelFor(t.sequences.status, item.status);
    const summary = [
      plural(item.stepCount, t.sequences.stepCount),
      plural(item.enrolledCount, t.sequences.enrolledCount),
    ].join(' · ');
    return (
      <RecordRow
        title={item.name}
        subtitle={item.description || undefined}
        meta={`${summary} · ${lastRunText(item)}`}
        badge={<Pill label={statusLabel} color={statusColor(item.status)} />}
        onPress={() => openSequence(item)}
      />
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <StackHeader title={t.sequences.title} onBack={() => router.back()} />

      <View style={styles.controls}>
        <SearchBar
          value={search}
          onChangeText={setSearch}
          placeholder={t.sequences.searchPlaceholder}
          autoCapitalize="none"
          autoCorrect={false}
          containerStyle={styles.search}
        />
      </View>

      <FlatList
        data={sequences.items}
        keyExtractor={(item) => item.id}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={sequences.refreshing} onRefresh={() => void sequences.refresh()} />
        }
        onEndReached={() => void sequences.loadMore()}
        onEndReachedThreshold={0.4}
        ListEmptyComponent={renderEmpty}
        ListFooterComponent={
          sequences.loadingMore ? <ActivityIndicator style={styles.footerSpinner} color={colors.text} /> : null
        }
        renderItem={renderItem}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 48 },
  controls: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8 },
  search: { borderRadius: 12 },
  listContent: { flexGrow: 1 },
  footerSpinner: { paddingVertical: 16 },
});
