/**
 * Agent inbox — open/closed desk conversations from `/api/desk/conversations`.
 * List-first layout matching WeldBooks' full-bleed rows + floating pill nav.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  RefreshControl,
  Pressable,
  TextInput,
} from 'react-native';
import { useObserve } from 'expo-observe';
import { useFocusEffect, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Inbox as InboxIcon, Mail, MessageSquare, Search, X } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { formatShortTime } from '@weldsuite/mobile-ui/utils/dateFormatter';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';

import api from '@/services/api';
import { ACCENTS, BRAND } from '@/lib/brand';
import { Screen, ScreenHeader } from '@/components/screen';
import { RecordRow } from '@/components/record-row';
import { IconTile } from '@/components/detail';
import { ErrorState, ListSkeleton } from '@/components/data-states';
import { ChannelBadge } from '@/components/status-badge';
import { useI18n } from '@/lib/i18n';
import { hideAppSplash } from '@/utils/splash';
import { useInboxRealtime } from '@/hooks/useInboxRealtime';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import type {
  DeskConversation,
  DeskConversationFilters,
  DeskConversationSort,
  DeskConversationState,
} from '@/types/desk';

type AssigneeFilter = 'all' | 'mine' | 'unassigned';

const SEARCH_DEBOUNCE_MS = 300;
type Translations = ReturnType<typeof useI18n>['t'];

const NEXT_SORT: Record<DeskConversationSort, DeskConversationSort> = {
  newest: 'waiting_longest',
  waiting_longest: 'oldest',
  oldest: 'newest',
};

function sortLabel(t: Translations, sort: DeskConversationSort): string {
  switch (sort) {
    case 'newest':
      return t.inbox.newest;
    case 'oldest':
      return t.inbox.oldest;
    default:
      return t.inbox.waitingLongest;
  }
}

function rowMeta(t: Translations, item: DeskConversation, waiting: boolean): string {
  if (waiting) return t.inbox.waiting;
  const number = `#${item.conversationNumber}`;
  return item.title ? `${number} · ${item.title}` : number;
}

export default function InboxScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { markInteractive } = useObserve();
  const { user } = useClerkAuth();
  const { t } = useI18n();

  const [items, setItems] = useState<DeskConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const [state, setState] = useState<DeskConversationState>('open');
  const [assigneeFilter, setAssigneeFilter] = useState<AssigneeFilter>('all');
  const [sort, setSort] = useState<DeskConversationSort>('newest');
  const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const debouncedSearch = useDebouncedValue(search.trim(), SEARCH_DEBOUNCE_MS);

  const filters = useMemo(() => {
    const base: DeskConversationFilters = { state };
    if (assigneeFilter === 'mine' && user?.id) base.assigneeId = user.id;
    if (assigneeFilter === 'unassigned') base.unassigned = true;
    if (debouncedSearch) base.q = debouncedSearch;
    return base;
  }, [state, assigneeFilter, user, debouncedSearch]);

  const fetchPage = useCallback(
    async (pageCursor?: string, append = false) => {
      try {
        setError(false);
        const res = await api.listConversations(filters, sort, pageCursor);
        if (!res.success || !res.data) {
          setError(true);
          return;
        }
        setItems((prev) => (append ? [...prev, ...res.data!.items] : res.data!.items));
        setHasMore(res.data.pagination.hasMore);
        setCursor(res.data.pagination.cursor);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
      }
    },
    [filters, sort],
  );

  useEffect(() => {
    setLoading(true);
    setItems([]);
    void fetchPage();
  }, [fetchPage]);

  useEffect(() => {
    if (!loading) {
      hideAppSplash();
      markInteractive();
    }
  }, [loading, markInteractive]);

  // Coming back from a thread: refresh silently so assignee/state changes show up.
  const skipFirstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (skipFirstFocus.current) {
        skipFirstFocus.current = false;
        return;
      }
      void fetchPage();
    }, [fetchPage]),
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void fetchPage();
  }, [fetchPage]);

  // Live inbox: dual-listen legacy `helpdesk.*` + hub desk_/helpdesk_ topics.
  const onInboxInvalidate = useCallback(() => {
    void fetchPage();
  }, [fetchPage]);

  useInboxRealtime({
    agentId: user?.id ?? '',
    agentName: user?.fullName ?? user?.email ?? '',
    onInboxInvalidate,
  });

  const onEndReached = useCallback(() => {
    if (!hasMore || loadingMore || !cursor) return;
    setLoadingMore(true);
    void fetchPage(cursor, true);
  }, [hasMore, loadingMore, cursor, fetchPage]);

  const openConversation = useCallback(
    (id: string) => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      router.push(`/conversation/${id}` as never);
    },
    [router],
  );

  const stateChips: { key: DeskConversationState; label: string }[] = [
    { key: 'open', label: t.inbox.open },
    { key: 'closed', label: t.inbox.closed },
  ];

  const assigneeChips: { key: AssigneeFilter; label: string }[] = [
    { key: 'all', label: t.inbox.all },
    { key: 'mine', label: t.inbox.mine },
    { key: 'unassigned', label: t.inbox.unassigned },
  ];

  let emptyTitle = state === 'open' ? t.inbox.emptyOpen : t.inbox.emptyClosed;
  if (debouncedSearch) emptyTitle = t.inbox.noResults;

  const header = (
    <ScreenHeader
      title={t.inbox.title}
      below={
        <View style={styles.filters}>
          <View style={[styles.searchBox, { backgroundColor: colors.secondary }]}>
            <Search size={16} color={colors.mutedForeground} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder={t.inbox.searchPlaceholder}
              placeholderTextColor={colors.mutedForeground}
              returnKeyType="search"
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="never"
              style={[styles.searchInput, { color: colors.text }]}
            />
            {search ? (
              <Pressable
                onPress={() => setSearch('')}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t.inbox.searchClear}
              >
                <X size={16} color={colors.mutedForeground} />
              </Pressable>
            ) : null}
          </View>
          <View style={styles.chipRow}>
            {stateChips.map((chip) => {
              const active = state === chip.key;
              return (
                <Pressable
                  key={chip.key}
                  onPress={() => setState(chip.key)}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: active ? colors.text : colors.secondary,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.chipText,
                      { color: active ? colors.background : colors.text },
                    ]}
                  >
                    {chip.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <View style={styles.chipRow}>
            {assigneeChips.map((chip) => {
              const active = assigneeFilter === chip.key;
              return (
                <Pressable
                  key={chip.key}
                  onPress={() => setAssigneeFilter(chip.key)}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: active ? BRAND_TINT_SAFE(colors) : colors.secondary,
                      borderColor: active ? BRAND : 'transparent',
                      borderWidth: StyleSheet.hairlineWidth,
                    },
                  ]}
                >
                  <Text style={[styles.chipText, { color: active ? BRAND : colors.text }]}>
                    {chip.label}
                  </Text>
                </Pressable>
              );
            })}
            <Pressable
              onPress={() =>
                setSort((s) => NEXT_SORT[s])
              }
              style={[styles.chip, { backgroundColor: colors.secondary }]}
            >
              <Text style={[styles.chipText, { color: colors.mutedForeground }]}>
                {sortLabel(t, sort)}
              </Text>
            </Pressable>
          </View>
        </View>
      }
    />
  );

  if (error && items.length === 0 && !loading) {
    return (
      <Screen header={header}>
        <ErrorState
          message={t.inbox.loadError}
          onRetry={() => {
            setLoading(true);
            void fetchPage();
          }}
        />
      </Screen>
    );
  }

  return (
    <Screen header={header}>
      {loading && items.length === 0 ? (
        <ListSkeleton />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          onEndReached={onEndReached}
          onEndReachedThreshold={0.4}
          ListEmptyComponent={
            <EmptyState
              icon={<InboxIcon size={40} color={colors.muted} />}
              title={emptyTitle}
              description={debouncedSearch ? t.inbox.noResultsHint : t.inbox.emptyHint}
            />
          }
          renderItem={({ item }) => {
            const waiting = Boolean(item.waitingSince);
            const title = item.name || item.email || t.inbox.noSubject;
            const subtitle = item.lastMessagePreview || item.title || item.email || '';
            const channelIcon = item.channel === 'email' ? Mail : MessageSquare;
            const channelColor =
              item.channel === 'email' ? ACCENTS.email : ACCENTS.chat;

            return (
              <RecordRow
                title={title}
                subtitle={subtitle}
                meta={rowMeta(t, item, waiting)}
                metaColor={waiting ? BRAND : undefined}
                trailing={formatShortTime(item.lastMessageAt ?? item.updatedAt)}
                unread={waiting}
                leading={<IconTile icon={channelIcon} color={channelColor} />}
                badge={<ChannelBadge channel={item.channel} />}
                onPress={() => openConversation(item.id)}
              />
            );
          }}
        />
      )}
    </Screen>
  );
}

/** Theme-aware brand tint for chips without importing StyleSheet-dependent rgba. */
function BRAND_TINT_SAFE(_colors: { secondary: string }): string {
  return 'rgba(30,143,249,0.12)';
}

const styles = StyleSheet.create({
  filters: { gap: 8 },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  searchInput: { flex: 1, fontSize: 15, paddingVertical: 0 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
  },
  chipText: { fontSize: 13, fontWeight: '600' },
});
