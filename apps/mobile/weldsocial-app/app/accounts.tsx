import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, FlatList, RefreshControl, TouchableOpacity, Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ArrowLeft, AtSign, Plus, RefreshCw } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { Avatar } from '@weldsuite/mobile-ui/components/Avatar';
import { Badge } from '@weldsuite/mobile-ui/components/Badge';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { Spinner } from '@weldsuite/mobile-ui/components/Spinner';
import { Banner } from '@weldsuite/mobile-ui/components/Banner';
import { Sheet } from '@weldsuite/mobile-ui/components/Sheet';
import type { SocialPlatform } from '@weldsuite/app-api-client/domains/social';
import { appApi } from '@/services/app-api';
import { useAsyncData } from '@/hooks/use-async-data';
import { useSocialRealtime } from '@/hooks/useSocialRealtime';
import { useI18n } from '@/lib/i18n';
import { useKeyboardSheet } from '@/hooks/use-keyboard-sheet';
import { ACCOUNT_STATUS_VARIANT, PLATFORM_META, formatCompact, statusBadge } from '@/lib/social';

const CONNECTABLE_PLATFORMS: SocialPlatform[] = ['facebook', 'instagram', 'twitter', 'linkedin', 'tiktok'];

export default function AccountsScreen() {
  const { colors } = useTheme();
  const { t, format, plural } = useI18n();
  const sheetProps = useKeyboardSheet();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();

  const [connectOpen, setConnectOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const fetcher = useCallback(async () => (await appApi.social.accounts.list({ limit: 100 })).data, []);
  const { data: accounts, loading, refreshing, error, refresh, reload } = useAsyncData(fetcher);

  useSocialRealtime({
    onInvalidate: useCallback(
      (surface) => {
        if (surface === 'accounts' || surface === 'any') reload();
      },
      [reload],
    ),
  });

  const handleConnect = async (platform: SocialPlatform) => {
    setBusy(`connect:${platform}`);
    try {
      // PostPeer hosted OAuth — open the returned URL in the browser, then the
      // user comes back and pulls the new channel in via Sync.
      const res = await appApi.social.accounts.connect(platform);
      setConnectOpen(false);
      if (res.data.url) await Linking.openURL(res.data.url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t.accounts.connectFailed);
    } finally {
      setBusy(null);
    }
  };

  const handleSync = async () => {
    setBusy('sync');
    try {
      const res = await appApi.social.accounts.sync();
      toast.success(
        res.data.synced > 0 ? plural(res.data.synced, t.accounts.imported) : t.accounts.upToDate,
      );
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t.accounts.syncFailed);
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: colors.divider }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerButton} accessibilityRole="button" accessibilityLabel={t.common.back}>
          <ArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>{t.accounts.title}</Text>
        <TouchableOpacity onPress={handleSync} style={styles.headerButton} accessibilityRole="button" accessibilityLabel={t.accounts.sync}>
          {busy === 'sync' ? <Spinner size={18} /> : <RefreshCw size={20} color={colors.text} />}
        </TouchableOpacity>
      </View>

      {error && (
        <View style={styles.bannerWrap}>
          <Banner variant="error" title={t.accounts.loadError}>{error}</Banner>
        </View>
      )}

      {loading && !accounts ? (
        <View style={styles.loading}>
          <Spinner label={t.common.loading} />
        </View>
      ) : (
        <FlatList
          data={accounts ?? []}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 96, gap: 10 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.muted} />}
          renderItem={({ item }) => {
            const platformMeta = PLATFORM_META[item.platform];
            const statusMeta = statusBadge(ACCOUNT_STATUS_VARIANT, t.accountStatus, item.status);
            return (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Avatar
                  name={item.name}
                  source={item.avatarUrl ? { uri: item.avatarUrl } : undefined}
                  size={44}
                />
                <View style={styles.cardBody}>
                  <Text style={[styles.accountName, { color: colors.text }]} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <View style={styles.accountMetaRow}>
                    <View style={[styles.platformDot, { backgroundColor: platformMeta?.color ?? colors.muted }]} />
                    <Text style={[styles.accountMeta, { color: colors.mutedForeground }]} numberOfLines={1}>
                      {platformMeta?.label ?? item.platform}
                      {item.username ? ` · @${item.username}` : ''}
                      {item.followerCount != null
                        ? ` · ${format(t.accounts.followers, { count: formatCompact(item.followerCount) })}`
                        : ''}
                    </Text>
                  </View>
                </View>
                <Badge variant={statusMeta.variant} label={statusMeta.label} />
              </View>
            );
          }}
          ListEmptyComponent={
            <EmptyState
              icon={<AtSign size={40} color={colors.mutedForeground} />}
              title={t.accounts.emptyTitle}
              description={t.accounts.emptyDescription}
              action={<Button title={t.accounts.connect} size="sm" onPress={() => setConnectOpen(true)} />}
            />
          }
        />
      )}

      <TouchableOpacity
        style={[styles.fab, { backgroundColor: colors.primary, bottom: insets.bottom + 24 }]}
        onPress={() => setConnectOpen(true)}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={t.accounts.connect}
      >
        <Plus size={24} color={colors.primaryForeground} />
      </TouchableOpacity>

      <Sheet
        {...sheetProps}
        visible={connectOpen}
        onClose={() => setConnectOpen(false)}
        title={t.accounts.connectSheetTitle}
      >
        <View style={{ gap: 10 }}>
          {CONNECTABLE_PLATFORMS.map((platform) => (
            <Button
              key={platform}
              title={PLATFORM_META[platform].label}
              variant="secondary"
              onPress={() => handleConnect(platform)}
              loading={busy === `connect:${platform}`}
              disabled={busy !== null}
              fullWidth
            />
          ))}
          <Text style={[styles.connectHint, { color: colors.mutedForeground }]}>
            {t.accounts.connectHint}
          </Text>
        </View>
      </Sheet>
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
  bannerWrap: { paddingHorizontal: 16, paddingTop: 8 },
  loading: { paddingTop: 64, alignItems: 'center' },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12, borderWidth: 1, padding: 12 },
  cardBody: { flex: 1, gap: 2 },
  accountName: { fontSize: 16, fontWeight: '600' },
  accountMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  platformDot: { width: 8, height: 8, borderRadius: 4 },
  accountMeta: { fontSize: 13, flexShrink: 1 },
  connectHint: { fontSize: 13, textAlign: 'center', marginTop: 4 },
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
