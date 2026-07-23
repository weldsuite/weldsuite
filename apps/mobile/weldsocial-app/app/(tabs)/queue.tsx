import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, FlatList, RefreshControl, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Pencil, Inbox } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { SegmentedControl } from '@weldsuite/mobile-ui/components/SegmentedControl';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { Spinner } from '@weldsuite/mobile-ui/components/Spinner';
import { Banner } from '@weldsuite/mobile-ui/components/Banner';
import type { SocialAccount, SocialPost, SocialPostStatus } from '@weldsuite/app-api-client/domains/social';
import appApi from '@/services/app-api';
import { useAsyncData } from '@/hooks/use-async-data';
import { PostCard } from '@/components/PostCard';

type Segment = 'scheduled' | 'drafts' | 'sent';

/** Which post statuses each segment shows. Lists are fetched per status and merged. */
const SEGMENT_STATUSES: Record<Segment, SocialPostStatus[]> = {
  scheduled: ['scheduled', 'publishing', 'approved'],
  drafts: ['draft', 'pending_approval'],
  sent: ['published', 'failed', 'cancelled'],
};

interface QueueData {
  posts: SocialPost[];
  accounts: SocialAccount[];
}

export default function QueueScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [segment, setSegment] = useState<Segment>('scheduled');

  const fetcher = useCallback(async (): Promise<QueueData> => {
    const statuses = SEGMENT_STATUSES[segment];
    const [accountsRes, ...postLists] = await Promise.all([
      appApi.social.accounts.list({ limit: 100 }),
      ...statuses.map((status) => appApi.social.posts.list({ status, limit: 50 })),
    ]);
    const posts = postLists
      .flatMap((res) => res.data)
      .sort((a, b) => {
        const aTime = a.scheduledAt ?? a.publishedAt ?? a.updatedAt;
        const bTime = b.scheduledAt ?? b.publishedAt ?? b.updatedAt;
        return segment === 'sent'
          ? new Date(bTime).getTime() - new Date(aTime).getTime()
          : new Date(aTime).getTime() - new Date(bTime).getTime();
      });
    return { posts, accounts: accountsRes.data };
  }, [segment]);

  const { data, loading, refreshing, error, refresh } = useAsyncData(fetcher);

  const accountsById = useMemo(
    () => new Map((data?.accounts ?? []).map((a) => [a.id, a])),
    [data?.accounts],
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Text style={[styles.title, { color: colors.text }]}>Queue</Text>
        <TouchableOpacity
          onPress={() => router.push('/compose')}
          style={[styles.newButton, { backgroundColor: colors.primary }]}
          accessibilityLabel="New post"
        >
          <Pencil size={18} color={colors.primaryForeground} />
        </TouchableOpacity>
      </View>

      <View style={styles.segment}>
        <SegmentedControl
          value={segment}
          onValueChange={(v) => setSegment(v as Segment)}
          options={[
            { label: 'Scheduled', value: 'scheduled' },
            { label: 'Drafts', value: 'drafts' },
            { label: 'Sent', value: 'sent' },
          ]}
        />
      </View>

      {error && (
        <View style={styles.bannerWrap}>
          <Banner variant="error" title="Couldn't load posts">{error}</Banner>
        </View>
      )}

      {loading && !data ? (
        <View style={styles.loading}>
          <Spinner label="Loading…" />
        </View>
      ) : (
        <FlatList
          data={data?.posts ?? []}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32, gap: 10 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.muted} />}
          renderItem={({ item }) => (
            <PostCard post={item} accountsById={accountsById} onPress={() => router.push(`/post/${item.id}`)} />
          )}
          ListEmptyComponent={
            <EmptyState
              icon={<Inbox size={40} color={colors.mutedForeground} />}
              title={segment === 'drafts' ? 'No drafts' : segment === 'sent' ? 'Nothing sent yet' : 'Nothing scheduled'}
              description="Create a post with the pencil button above."
            />
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 12 },
  title: { fontSize: 34, fontWeight: '700' },
  newButton: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  segment: { paddingHorizontal: 16, marginBottom: 4 },
  bannerWrap: { paddingHorizontal: 16, paddingTop: 8 },
  loading: { paddingTop: 64, alignItems: 'center' },
});
