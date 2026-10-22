import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack, router } from 'expo-router';
import { ChevronRight } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { StackHeader } from '@/components/headers';
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
    if (sequences.loading) {
      return (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.text} />
        </View>
      );
    }
    if (sequences.error) {
      return (
        <View style={styles.emptyState}>
          <Text style={[styles.emptyTitle, { color: colors.text }]}>{t.sequences.loadFailed}</Text>
          <Text style={[styles.emptyText, { color: colors.muted }]}>{t.common.pullToRetry}</Text>
        </View>
      );
    }
    return (
      <View style={styles.emptyState}>
        <Text style={[styles.emptyTitle, { color: colors.text }]}>
          {search ? t.sequences.emptyFiltered : t.sequences.empty}
        </Text>
        {!search && <Text style={[styles.emptyText, { color: colors.muted }]}>{t.sequences.emptyHint}</Text>}
      </View>
    );
  };

  const renderItem = ({ item }: { item: CrmSequence }) => {
    const color = statusColor(item.status);
    const statusLabel = labelFor(t.sequences.status, item.status);
    const summary = [
      plural(item.stepCount, t.sequences.stepCount),
      plural(item.enrolledCount, t.sequences.enrolledCount),
    ].join(' · ');
    return (
      <TouchableOpacity
        style={[styles.card, { backgroundColor: colors.background, borderColor: colors.divider }]}
        activeOpacity={0.7}
        onPress={() => openSequence(item)}
        accessibilityRole="button"
        accessibilityLabel={`${item.name}, ${statusLabel}, ${summary}`}
      >
        <View style={styles.cardHeader}>
          <Text style={[styles.cardTitle, { color: colors.text }]} numberOfLines={1}>
            {item.name}
          </Text>
          <View style={[styles.statusBadge, { backgroundColor: `${color}20` }]}>
            <Text style={[styles.statusText, { color }]}>{statusLabel}</Text>
          </View>
        </View>
        {!!item.description && (
          <Text style={[styles.cardDescription, { color: colors.muted }]} numberOfLines={2}>
            {item.description}
          </Text>
        )}
        <View style={styles.cardFooter}>
          <View style={styles.cardFooterText}>
            <Text style={[styles.cardMeta, { color: colors.text }]} numberOfLines={1}>
              {summary}
            </Text>
            <Text style={[styles.cardMetaMuted, { color: colors.muted }]} numberOfLines={1}>
              {lastRunText(item)}
            </Text>
          </View>
          <ChevronRight size={18} color={colors.muted} />
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <StackHeader title={t.sequences.title} onBack={() => router.back()} />

      <View style={[styles.searchBar, { backgroundColor: colors.inputBackground }]}>
        <TextInput
          style={[styles.searchInput, { color: colors.text }]}
          placeholder={t.sequences.searchPlaceholder}
          placeholderTextColor={colors.muted}
          value={search}
          onChangeText={setSearch}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel={t.sequences.searchPlaceholder}
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
  searchBar: { marginHorizontal: 16, marginTop: 12, marginBottom: 4, borderRadius: 10 },
  searchInput: { paddingHorizontal: 12, paddingVertical: 10, fontSize: 14 },
  listContent: { padding: 16, paddingTop: 8, flexGrow: 1 },
  footerSpinner: { paddingVertical: 16 },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 48, paddingHorizontal: 32 },
  emptyTitle: { fontSize: 16, fontWeight: '600', marginBottom: 6, textAlign: 'center' },
  emptyText: { fontSize: 13, textAlign: 'center' },
  card: { borderRadius: 12, borderWidth: 1, padding: 14, marginBottom: 12, gap: 8 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  cardTitle: { flex: 1, fontSize: 15, fontWeight: '600' },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  statusText: { fontSize: 11, fontWeight: '600' },
  cardDescription: { fontSize: 13 },
  cardFooter: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardFooterText: { flex: 1, gap: 2 },
  cardMeta: { fontSize: 13, fontWeight: '500' },
  cardMetaMuted: { fontSize: 12 },
});
