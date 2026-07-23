import React, { useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, RefreshControl, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ArrowLeft, BarChart3 } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Spinner } from '@weldsuite/mobile-ui/components/Spinner';
import { Banner } from '@weldsuite/mobile-ui/components/Banner';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import type { SocialAnalyticsOverview, SocialDashboardStats } from '@weldsuite/app-api-client/domains/social';
import appApi from '@/services/app-api';
import { useAsyncData } from '@/hooks/use-async-data';
import { PLATFORM_META, formatCompact } from '@/lib/social';
import type { SocialPlatform } from '@weldsuite/app-api-client/domains/social';

interface AnalyticsData {
  overview: SocialAnalyticsOverview;
  stats: SocialDashboardStats;
}

export default function AnalyticsScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const fetcher = useCallback(async (): Promise<AnalyticsData> => {
    const [overviewRes, statsRes] = await Promise.all([
      appApi.social.analytics.overview(),
      appApi.social.analytics.stats(),
    ]);
    return { overview: overviewRes.data, stats: statsRes.data };
  }, []);

  const { data, loading, refreshing, error, refresh } = useAsyncData(fetcher);

  const tiles = data
    ? [
        { label: 'Impressions', value: data.overview.totalImpressions },
        { label: 'Reach', value: data.overview.totalReach },
        { label: 'Engagement', value: data.overview.totalEngagement },
        { label: 'Clicks', value: data.overview.totalClicks },
      ]
    : [];

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: colors.divider }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerButton} accessibilityLabel="Back">
          <ArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Analytics</Text>
        <View style={styles.headerButton} />
      </View>

      {loading && !data ? (
        <View style={styles.loading}>
          <Spinner label="Loading…" />
        </View>
      ) : (
        <ScrollView
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.muted} />}
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32 }}
        >
          {error && (
            <Banner variant="error" title="Couldn't load analytics">{error}</Banner>
          )}

          {data && (
            <>
              <View style={styles.statGrid}>
                {tiles.map((tile) => (
                  <View
                    key={tile.label}
                    style={[styles.statTile, { backgroundColor: colors.card, borderColor: colors.border }]}
                  >
                    <Text style={[styles.statValue, { color: colors.text }]}>{formatCompact(tile.value)}</Text>
                    <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>{tile.label}</Text>
                  </View>
                ))}
              </View>

              <View style={[styles.rateCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Text style={[styles.rateValue, { color: colors.text }]}>
                  {data.overview.engagementRate.toFixed(2)}%
                </Text>
                <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>Engagement rate</Text>
              </View>

              <Text style={[styles.sectionTitle, { color: colors.text }]}>Platforms</Text>
              {data.overview.platformStats.length ? (
                <View style={{ gap: 10 }}>
                  {data.overview.platformStats.map((stat, index) => {
                    const meta = PLATFORM_META[stat.platform as SocialPlatform];
                    return (
                      <View
                        key={`${stat.platform}-${index}`}
                        style={[styles.platformRow, { backgroundColor: colors.card, borderColor: colors.border }]}
                      >
                        <View style={[styles.platformDot, { backgroundColor: meta?.color ?? colors.muted }]} />
                        <Text style={[styles.platformName, { color: colors.text }]}>
                          {meta?.label ?? stat.platform}
                        </Text>
                        <View style={styles.platformStats}>
                          <Text style={[styles.platformStat, { color: colors.mutedForeground }]}>
                            {formatCompact(stat.followers)} followers
                          </Text>
                          <Text style={[styles.platformStat, { color: colors.mutedForeground }]}>
                            {stat.posts} posts
                          </Text>
                        </View>
                      </View>
                    );
                  })}
                </View>
              ) : (
                <EmptyState
                  icon={<BarChart3 size={40} color={colors.mutedForeground} />}
                  title="No platform data yet"
                  description="Connect accounts and publish posts to see analytics."
                />
              )}
            </>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingBottom: 12,
    borderBottomWidth: 0.5,
  },
  headerButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 17, fontWeight: '600' },
  loading: { paddingTop: 64, alignItems: 'center' },
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 10 },
  statTile: { flexBasis: '47%', flexGrow: 1, borderRadius: 12, borderWidth: 1, padding: 14 },
  statValue: { fontSize: 26, fontWeight: '700' },
  statLabel: { fontSize: 13, marginTop: 2 },
  rateCard: { borderRadius: 12, borderWidth: 1, padding: 14, marginBottom: 24 },
  rateValue: { fontSize: 30, fontWeight: '700' },
  sectionTitle: { fontSize: 20, fontWeight: '700', marginBottom: 10 },
  platformRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 12, borderWidth: 1, padding: 14 },
  platformDot: { width: 12, height: 12, borderRadius: 6 },
  platformName: { flex: 1, fontSize: 16, fontWeight: '600' },
  platformStats: { alignItems: 'flex-end' },
  platformStat: { fontSize: 13 },
});
