import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, FlatList, RefreshControl, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ArrowLeft, Megaphone, Plus } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { Badge } from '@weldsuite/mobile-ui/components/Badge';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { Spinner } from '@weldsuite/mobile-ui/components/Spinner';
import { Banner } from '@weldsuite/mobile-ui/components/Banner';
import { Sheet } from '@weldsuite/mobile-ui/components/Sheet';
import { Input } from '@weldsuite/mobile-ui/components/Input';
import { Textarea } from '@weldsuite/mobile-ui/components/Textarea';
import appApi from '@/services/app-api';
import { useAsyncData } from '@/hooks/use-async-data';
import { CAMPAIGN_STATUS_META, formatDateTime } from '@/lib/social';

export default function CampaignsScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);

  const fetcher = useCallback(async () => (await appApi.social.campaigns.list({ limit: 100 })).data, []);
  const { data: campaigns, loading, refreshing, error, refresh, reload } = useAsyncData(fetcher);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      await appApi.social.campaigns.create({
        name: name.trim(),
        description: description.trim() || undefined,
      });
      toast.success('Campaign created');
      setName('');
      setDescription('');
      setCreateOpen(false);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create campaign');
    } finally {
      setCreating(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: colors.divider }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerButton} accessibilityLabel="Back">
          <ArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Campaigns</Text>
        <TouchableOpacity onPress={() => setCreateOpen(true)} style={styles.headerButton} accessibilityLabel="New campaign">
          <Plus size={22} color={colors.text} />
        </TouchableOpacity>
      </View>

      {error && (
        <View style={styles.bannerWrap}>
          <Banner variant="error" title="Couldn't load campaigns">{error}</Banner>
        </View>
      )}

      {loading && !campaigns ? (
        <View style={styles.loading}>
          <Spinner label="Loading…" />
        </View>
      ) : (
        <FlatList
          data={campaigns ?? []}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32, gap: 10 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.muted} />}
          renderItem={({ item }) => {
            const statusMeta = CAMPAIGN_STATUS_META[item.status] ?? { label: item.status, variant: 'outline' as const };
            return (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={styles.cardTop}>
                  <View style={styles.nameRow}>
                    {!!item.color && <View style={[styles.colorDot, { backgroundColor: item.color }]} />}
                    <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>
                      {item.name}
                    </Text>
                  </View>
                  <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
                </View>
                {!!item.description && (
                  <Text style={[styles.description, { color: colors.mutedForeground }]} numberOfLines={2}>
                    {item.description}
                  </Text>
                )}
                {(item.startDate || item.endDate) && (
                  <Text style={[styles.dates, { color: colors.muted }]}>
                    {item.startDate ? formatDateTime(item.startDate) : '…'} — {item.endDate ? formatDateTime(item.endDate) : '…'}
                  </Text>
                )}
              </View>
            );
          }}
          ListEmptyComponent={
            <EmptyState
              icon={<Megaphone size={40} color={colors.mutedForeground} />}
              title="No campaigns"
              description="Group related posts into a campaign to track them together."
              action={<Button title="New campaign" size="sm" onPress={() => setCreateOpen(true)} />}
            />
          }
        />
      )}

      <Sheet visible={createOpen} onClose={() => setCreateOpen(false)} title="New campaign">
        <View style={{ gap: 12 }}>
          <Input label="Name" placeholder="Summer launch" value={name} onChangeText={setName} />
          <Textarea label="Description" placeholder="Optional" value={description} onChangeText={setDescription} />
          <Button
            title="Create campaign"
            onPress={handleCreate}
            disabled={!name.trim() || creating}
            loading={creating}
            fullWidth
          />
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
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 6 },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  colorDot: { width: 10, height: 10, borderRadius: 5 },
  name: { fontSize: 16, fontWeight: '600', flexShrink: 1 },
  description: { fontSize: 14, lineHeight: 20 },
  dates: { fontSize: 12 },
});
