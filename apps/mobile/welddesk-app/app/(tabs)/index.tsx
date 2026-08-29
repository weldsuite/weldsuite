/**
 * Agent inbox — open/closed desk conversations from `/api/desk/conversations`.
 * List-first layout matching WeldBooks' full-bleed rows + floating pill nav.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  RefreshControl,
  Pressable,
} from 'react-native';
import { useObserve } from 'expo-observe';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Inbox as InboxIcon, Mail, MessageSquare } from 'lucide-react-native';
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
import type {
  DeskConversation,
  DeskConversationSort,
  DeskConversationState,
} from '@/types/desk';

type AssigneeFilter = 'all' | 'mine' | 'unassigned';

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
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const filters = useMemo(() => {
    const base: { state: DeskConversationState; assigneeId?: string; unassigned?: boolean } = {
      state,
    };
    if (assigneeFilter === 'mine' && user?.id) base.assigneeId = user.id;
    if (assigneeFilter === 'unassigned') base.unassigned = true;
    return base;
  }, [state, assigneeFilter, user?.id]);

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

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void fetchPage();
  }, [fetchPage]);

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

  const header = (
    <ScreenHeader
      title={t.inbox.title}
      below={
        <View style={styles.filters}>
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
                setSort((s) =>
                  s === 'newest' ? 'waiting_longest' : s === 'waiting_longest' ? 'oldest' : 'newest',
                )
              }
              style={[styles.chip, { backgroundColor: colors.secondary }]}
            >
              <Text style={[styles.chipText, { color: colors.mutedForeground }]}>
                {sort === 'newest'
                  ? t.inbox.newest
                  : sort === 'oldest'
                    ? t.inbox.oldest
                    : t.inbox.waitingLongest}
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
              title={state === 'open' ? t.inbox.emptyOpen : t.inbox.emptyClosed}
              description={t.inbox.emptyHint}
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
                meta={
                  waiting
                    ? t.inbox.waiting
                    : item.title
                      ? `#${item.conversationNumber} · ${item.title}`
                      : `#${item.conversationNumber}`
                }
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
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
  },
  chipText: { fontSize: 13, fontWeight: '600' },
});
