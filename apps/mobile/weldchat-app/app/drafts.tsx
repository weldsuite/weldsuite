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
import { ChevronLeft, SquarePen, Trash2 } from 'lucide-react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/contexts/ThemeContext';
import type { ColorScheme } from '@/constants/colors';
import { appApiClient, appApi } from '@/services/app-api';

interface DraftRecord {
  id: string;
  userId: string;
  workspaceId: string;
  channelId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

interface HydratedDraft extends DraftRecord {
  channelName: string;
  channelType: string;
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function DraftsScreen() {
  const { userId } = useAuth();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors, insets.top, insets.bottom), [colors, insets.top, insets.bottom]);

  const [drafts, setDrafts] = useState<HydratedDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadDrafts = useCallback(async () => {
    if (!userId) return;
    try {
      // Server scopes drafts to the authenticated caller (JWT) — no
      // client-supplied userId.
      const res = await appApiClient.get<{ data: DraftRecord[] }>(`/chat-drafts`);
      const raw: DraftRecord[] = res.data ?? [];

      // Hydrate channel names
      const hydrated: HydratedDraft[] = await Promise.all(
        raw.map(async (d) => {
          try {
            const chRes = await appApi.channels.get(d.channelId);
            const ch: any = chRes.data ?? {};
            return { ...d, channelName: ch.name ?? d.channelId, channelType: ch.type ?? 'public' };
          } catch {
            return { ...d, channelName: d.channelId, channelType: 'public' };
          }
        })
      );

      // Sort newest first
      hydrated.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      setDrafts(hydrated);
    } catch (err) {
      console.error('[Drafts] loadDrafts failed:', err);
    }
  }, [userId]);

  useEffect(() => {
    setLoading(true);
    loadDrafts().finally(() => setLoading(false));
  }, [loadDrafts]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadDrafts();
    setRefreshing(false);
  }, [loadDrafts]);

  const handleDelete = useCallback(async (draft: HydratedDraft) => {
    setDrafts((prev) => prev.filter((d) => d.id !== draft.id));
    try {
      await appApiClient.delete(`/chat-drafts/${draft.id}`);
    } catch {
      loadDrafts();
    }
  }, [loadDrafts]);

  const handleTap = useCallback((draft: HydratedDraft) => {
    // Navigate to the channel/DM; the channel screen will pick up the draft
    // from the API on mount and prefill the composer.
    if (draft.channelType === 'dm') {
      router.push(`/dm/${draft.channelId}` as any);
    } else {
      router.push(`/channel/${draft.channelId}` as any);
    }
  }, [router]);

  const renderRightActions = useCallback(
    (draft: HydratedDraft) => (
      <TouchableOpacity
        style={styles.swipeDelete}
        onPress={() => handleDelete(draft)}
      >
        <Trash2 size={20} color="#fff" />
        <Text style={styles.swipeText}>Delete</Text>
      </TouchableOpacity>
    ),
    [handleDelete, styles],
  );

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <ChevronLeft size={24} color={colors.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Drafts</Text>
        </View>

        <FlatList
          data={drafts}
          keyExtractor={(item) => item.id}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand} colors={[colors.brand]} />
          }
          contentContainerStyle={drafts.length === 0 && !loading ? styles.emptyContainer : styles.list}
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
                  <SquarePen size={16} color={colors.brand} />
                </View>
                <View style={styles.itemBody}>
                  <Text style={styles.itemChannel} numberOfLines={1}>
                    {item.channelType === 'dm' ? item.channelName : `#${item.channelName}`}
                  </Text>
                  <Text style={styles.itemContent} numberOfLines={2}>{item.content}</Text>
                </View>
                <Text style={styles.itemTime}>{formatRelativeTime(item.updatedAt)}</Text>
              </TouchableOpacity>
            </Swipeable>
          )}
          ListEmptyComponent={
            !loading ? (
              <View style={styles.empty}>
                <SquarePen size={48} color={colors.textMuted} strokeWidth={1.5} />
                <Text style={styles.emptyTitle}>No drafts</Text>
                <Text style={styles.emptyText}>
                  Unfinished messages will show up here so you can pick up where you left off.
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
    itemChannel: { fontSize: 12, color: c.brand, fontWeight: '600', marginBottom: 3 },
    itemContent: { fontSize: 14, color: c.textSecondary, lineHeight: 19 },
    itemTime: { fontSize: 12, color: c.textMuted, marginTop: 2 },
    swipeDelete: {
      width: 80,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: '#ef4444',
    },
    swipeText: { fontSize: 11, fontWeight: '600', color: '#fff', marginTop: 4 },
  });
