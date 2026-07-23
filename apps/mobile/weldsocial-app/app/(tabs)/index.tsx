import React, { useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, RefreshControl, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Pencil, ChevronRight } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';
import { useWorkspace } from '@weldsuite/mobile-ui/contexts/WorkspaceContext';
import { Spinner } from '@weldsuite/mobile-ui/components/Spinner';
import { Banner } from '@weldsuite/mobile-ui/components/Banner';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import type { SocialAccount, SocialDashboardStats, SocialPost } from '@weldsuite/app-api-client/domains/social';
import appApi from '@/services/app-api';
import { useAsyncData } from '@/hooks/use-async-data';
import { PostCard } from '@/components/PostCard';
import { formatCompact } from '@/lib/social';

interface DashboardData {
  stats: SocialDashboardStats | null;
  upcoming: SocialPost[];
  accounts: SocialAccount[];
}

export default function HomeScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useClerkAuth();
  const { currentWorkspace } = useWorkspace();

  const fetcher = useCallback(async (): Promise<DashboardData> => {
    const [statsRes, scheduledRes, accountsRes] = await Promise.all([
      appApi.social.analytics.stats().catch(() => null),
      appApi.social.posts.list({ status: 'scheduled', limit: 5 }),
      appApi.social.accounts.list({ limit: 100 }),
    ]);
    return {
      stats: statsRes?.data ?? null,
      upcoming: scheduledRes.data,
      accounts: accountsRes.data,
    };
  }, []);

  const { data, loading, refreshing, error, refresh } = useAsyncData(fetcher);

  const accountsById = useMemo(
    () => new Map((data?.accounts ?? []).map((a) => [a.id, a])),
    [data?.accounts],
  );

  const statTiles = data?.stats
    ? [
        { label: 'Scheduled', value: data.stats.scheduledPosts },
        { label: 'Published this week', value: data.stats.publishedThisWeek },
        { label: 'Pending approval', value: data.stats.pendingApproval },
        { label: 'Connected accounts', value: data.stats.connectedAccounts },
      ]
    : [];

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.muted} />}
        contentContainerStyle={{ paddingBottom: insets.bottom + 96 }}
      >
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
          <Text style={[styles.greeting, { color: colors.muted }]}>
            {currentWorkspace?.name || 'Workspace'}
          </Text>
          <Text style={[styles.title, { color: colors.text }]}>
            Hey, {user?.firstName || 'there'}
          </Text>
        </View>

        {error && (
          <View style={styles.section}>
            <Banner variant="error" title="Couldn't load dashboard">{error}</Banner>
          </View>
        )}

        {loading && !data ? (
          <View style={styles.loading}>
            <Spinner label="Loading…" />
          </View>
        ) : (
          <>
            {statTiles.length > 0 && (
              <View style={styles.statGrid}>
                {statTiles.map((tile) => (
                  <View
                    key={tile.label}
                    style={[styles.statTile, { backgroundColor: colors.card, borderColor: colors.border }]}
                  >
                    <Text style={[styles.statValue, { color: colors.text }]}>{formatCompact(tile.value)}</Text>
                    <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>{tile.label}</Text>
                  </View>
                ))}
              </View>
            )}

            <View style={styles.section}>
              <TouchableOpacity style={styles.sectionHeader} onPress={() => router.push('/(tabs)/queue')}>
                <Text style={[styles.sectionTitle, { color: colors.text }]}>Up next</Text>
                <ChevronRight size={18} color={colors.muted} />
              </TouchableOpacity>
              {data?.upcoming.length ? (
                <View style={styles.list}>
                  {data.upcoming.map((post) => (
                    <PostCard
                      key={post.id}
                      post={post}
                      accountsById={accountsById}
                      onPress={() => router.push(`/post/${post.id}`)}
                    />
                  ))}
                </View>
              ) : (
                <EmptyState
                  title="Nothing scheduled"
                  description="Posts you schedule will show up here."
                />
              )}
            </View>
          </>
        )}
      </ScrollView>

      <TouchableOpacity
        style={[styles.fab, { backgroundColor: colors.primary, bottom: insets.bottom + 24 }]}
        onPress={() => router.push('/compose')}
        activeOpacity={0.85}
        accessibilityLabel="New post"
      >
        <Pencil size={22} color={colors.primaryForeground} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 16, paddingBottom: 16 },
  greeting: { fontSize: 15, fontWeight: '500', marginBottom: 4 },
  title: { fontSize: 34, fontWeight: '700' },
  loading: { paddingTop: 64, alignItems: 'center' },
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingHorizontal: 16, marginBottom: 24 },
  statTile: { flexBasis: '47%', flexGrow: 1, borderRadius: 12, borderWidth: 1, padding: 14 },
  statValue: { fontSize: 26, fontWeight: '700' },
  statLabel: { fontSize: 13, marginTop: 2 },
  section: { paddingHorizontal: 16, marginBottom: 24 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  sectionTitle: { fontSize: 20, fontWeight: '700' },
  list: { gap: 10 },
  fab: {
    position: 'absolute',
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
});
