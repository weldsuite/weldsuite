import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  RefreshControl,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useAuth } from '@clerk/expo';
import { ChevronLeft, Bookmark, Trash2 } from 'lucide-react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/ThemeContext';
import type { ColorScheme } from '@/constants/colors';
import { appApiClient, appApi } from '@/services/app-api';

interface BookmarkRecord {
  id: string;
  userId: string;
  messageId: string;
  channelId: string;
  note?: string | null;
  createdAt: string;
}

interface HydratedBookmark extends BookmarkRecord {
  content: string;
  authorName: string;
  channelName: string;
  channelType: string;
}

export default function LaterScreen() {
  const { userId } = useAuth();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors, insets.top, insets.bottom), [colors, insets.top, insets.bottom]);

  const [bookmarks, setBookmarks] = useState<HydratedBookmark[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadBookmarks = useCallback(async () => {
    if (!userId) return;
    try {
      // Server scopes bookmarks to the authenticated caller (JWT) — no
      // client-supplied userId.
      const res = await appApiClient.get<{ data: BookmarkRecord[] }>(
        `/chat-bookmarks?limit=50`
      );
      const raw: BookmarkRecord[] = res.data ?? [];

      // Hydrate each bookmark by fetching its channel + messages
      const hydrated: HydratedBookmark[] = await Promise.all(
        raw.map(async (bm) => {
          try {
            const [msgsRes, chRes] = await Promise.all([
              appApi.chatMessages.list({ channelId: bm.channelId }),
              appApi.channels.get(bm.channelId),
            ]);
            const msgs: any[] = (msgsRes.data ?? []) as any[];
            const msg = msgs.find((m: any) => m.id === bm.messageId);
            const ch: any = chRes.data ?? {};
            return {
              ...bm,
              content: msg?.content ?? '(message unavailable)',
              authorName: msg?.authorName ?? 'Unknown',
              channelName: ch.name ?? 'Unknown channel',
              channelType: ch.type ?? 'public',
            };
          } catch {
            return {
              ...bm,
              content: '(message unavailable)',
              authorName: 'Unknown',
              channelName: 'Unknown channel',
              channelType: 'public',
            };
          }
        })
      );
      setBookmarks(hydrated);
    } catch (err) {
      console.error('[Later] loadBookmarks failed:', err);
    }
  }, [userId]);

  useEffect(() => {
    setLoading(true);
    loadBookmarks().finally(() => setLoading(false));
  }, [loadBookmarks]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadBookmarks();
    setRefreshing(false);
  }, [loadBookmarks]);

  const handleRemove = useCallback(async (bm: HydratedBookmark) => {
    setBookmarks((prev) => prev.filter((b) => b.id !== bm.id));
    try {
      await appApiClient.delete(`/chat-bookmarks/${bm.id}`);
    } catch {
      loadBookmarks();
    }
  }, [loadBookmarks]);

  const handleTap = useCallback((bm: HydratedBookmark) => {
    if (bm.channelType === 'dm') {
      router.push(`/dm/${bm.channelId}` as any);
    } else {
      router.push(`/channel/${bm.channelId}` as any);
    }
  }, [router]);

  const renderRightActions = useCallback(
    (bm: HydratedBookmark) => (
      <TouchableOpacity
        style={styles.swipeDelete}
        onPress={() => handleRemove(bm)}
      >
        <Trash2 size={20} color="#fff" />
        <Text style={styles.swipeText}>Remove</Text>
      </TouchableOpacity>
    ),
    [handleRemove, styles],
  );

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <ChevronLeft size={24} color={colors.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Saved</Text>
        </View>

        <FlatList
          data={bookmarks}
          keyExtractor={(item) => item.id}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand} colors={[colors.brand]} />
          }
          contentContainerStyle={bookmarks.length === 0 && !loading ? styles.emptyContainer : styles.list}
          renderItem={({ item }) => (
            <Swipeable
              renderRightActions={() => renderRightActions(item)}
              overshootRight={false}
              friction={1.5}
              rightThreshold={40}
            >
              <TouchableOpacity
                style={styles.item}
                activeOpacity={0.7}
                onPress={() => handleTap(item)}
              >
                <View style={styles.itemIcon}>
                  <Bookmark size={16} color={colors.brand} />
                </View>
                <View style={styles.itemBody}>
                  <Text style={styles.itemChannel} numberOfLines={1}>
                    {item.channelType === 'dm' ? item.channelName : `#${item.channelName}`}
                  </Text>
                  <Text style={styles.itemAuthor} numberOfLines={1}>{item.authorName}</Text>
                  <Text style={styles.itemContent} numberOfLines={2}>{item.content}</Text>
                  {item.note ? <Text style={styles.itemNote} numberOfLines={1}>{item.note}</Text> : null}
                </View>
                <Text style={styles.itemTime}>
                  {new Date(item.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                </Text>
              </TouchableOpacity>
            </Swipeable>
          )}
          ListEmptyComponent={
            !loading ? (
              <View style={styles.empty}>
                <Bookmark size={48} color={colors.textMuted} strokeWidth={1.5} />
                <Text style={styles.emptyTitle}>Nothing saved yet</Text>
                <Text style={styles.emptyText}>
                  Long-press a message and tap Save Message to keep it here for easy access.
                </Text>
              </View>
            ) : null
          }
        />
      </View>
    </>
  );
}

const makeStyles = (c: ColorScheme, topInset: number, bottomInset: number) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bgPrimary },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingTop: topInset + 8,
      paddingHorizontal: 16,
      paddingBottom: 10,
      backgroundColor: c.bgPrimary,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
      gap: 8,
    },
    backBtn: { padding: 4 },
    headerTitle: { fontSize: 18, fontWeight: '700', color: c.textPrimary },
    list: { paddingBottom: 24 + bottomInset },
    emptyContainer: { flex: 1 },
    empty: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 32,
      gap: 12,
    },
    emptyTitle: { fontSize: 18, fontWeight: '600', color: c.textPrimary },
    emptyText: { fontSize: 14, color: c.textMuted, textAlign: 'center', maxWidth: 280, lineHeight: 20 },
    item: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      paddingHorizontal: 16,
      paddingVertical: 12,
      backgroundColor: c.bgPrimary,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
      gap: 10,
    },
    itemIcon: {
      width: 32,
      height: 32,
      borderRadius: 10,
      backgroundColor: c.bgSecondary,
      justifyContent: 'center',
      alignItems: 'center',
      marginTop: 2,
    },
    itemBody: { flex: 1 },
    itemChannel: { fontSize: 12, color: c.brand, fontWeight: '600', marginBottom: 1 },
    itemAuthor: { fontSize: 13, fontWeight: '600', color: c.textPrimary, marginBottom: 2 },
    itemContent: { fontSize: 14, color: c.textSecondary, lineHeight: 19 },
    itemNote: { fontSize: 12, color: c.textMuted, fontStyle: 'italic', marginTop: 4 },
    itemTime: { fontSize: 12, color: c.textMuted, marginTop: 2 },
    swipeDelete: {
      width: 80,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: '#ef4444',
    },
    swipeText: { fontSize: 11, fontWeight: '600', color: '#fff', marginTop: 4 },
  });
