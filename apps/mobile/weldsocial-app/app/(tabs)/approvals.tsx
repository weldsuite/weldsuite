import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, FlatList, RefreshControl } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { BadgeCheck } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { Badge } from '@weldsuite/mobile-ui/components/Badge';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { EmptyState } from '@weldsuite/mobile-ui/components/EmptyState';
import { Spinner } from '@weldsuite/mobile-ui/components/Spinner';
import { Banner } from '@weldsuite/mobile-ui/components/Banner';
import { Sheet } from '@weldsuite/mobile-ui/components/Sheet';
import { Textarea } from '@weldsuite/mobile-ui/components/Textarea';
import { SegmentedControl } from '@weldsuite/mobile-ui/components/SegmentedControl';
import type { SocialApproval, SocialPost } from '@weldsuite/app-api-client/domains/social';
import appApi from '@/services/app-api';
import { useAsyncData } from '@/hooks/use-async-data';
import { APPROVAL_STATUS_META, formatDateTime } from '@/lib/social';

type Segment = 'pending' | 'decided';

interface ApprovalsData {
  approvals: SocialApproval[];
  postsById: Map<string, SocialPost>;
}

interface Decision {
  approval: SocialApproval;
  status: 'approved' | 'rejected';
}

export default function ApprovalsScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();

  const [segment, setSegment] = useState<Segment>('pending');
  const [decision, setDecision] = useState<Decision | null>(null);
  const [notes, setNotes] = useState('');
  const [deciding, setDeciding] = useState(false);

  const fetcher = useCallback(async (): Promise<ApprovalsData> => {
    const approvals =
      segment === 'pending'
        ? (await appApi.social.approvals.list({ status: 'pending', limit: 50 })).data
        : (
            await Promise.all([
              appApi.social.approvals.list({ status: 'approved', limit: 25 }),
              appApi.social.approvals.list({ status: 'rejected', limit: 25 }),
            ])
          )
            .flatMap((res) => res.data)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    // Fetch the referenced posts so each approval row can show the content.
    const postIds = [...new Set(approvals.map((a) => a.postId))];
    const posts = await Promise.all(
      postIds.map((postId) => appApi.social.posts.get(postId).then((r) => r.data).catch(() => null)),
    );
    const postsById = new Map(posts.filter((p): p is SocialPost => !!p).map((p) => [p.id, p]));
    return { approvals, postsById };
  }, [segment]);

  const { data, loading, refreshing, error, refresh, reload } = useAsyncData(fetcher);

  const openDecision = (approval: SocialApproval, status: Decision['status']) => {
    setNotes('');
    setDecision({ approval, status });
  };

  const submitDecision = async () => {
    if (!decision) return;
    setDeciding(true);
    try {
      // Same shape the web approvals screen sends — the server owns any
      // follow-on post status transitions.
      await appApi.social.approvals.update(decision.approval.id, {
        status: decision.status,
        decisionNotes: notes.trim() || undefined,
      });
      toast.success(decision.status === 'approved' ? 'Post approved' : 'Post rejected');
      setDecision(null);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save decision');
    } finally {
      setDeciding(false);
    }
  };

  const listData = useMemo(() => data?.approvals ?? [], [data?.approvals]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Text style={[styles.title, { color: colors.text }]}>Approvals</Text>
      </View>

      <View style={styles.segment}>
        <SegmentedControl
          value={segment}
          onValueChange={(v) => setSegment(v as Segment)}
          options={[
            { label: 'Pending', value: 'pending' },
            { label: 'Decided', value: 'decided' },
          ]}
        />
      </View>

      {error && (
        <View style={styles.bannerWrap}>
          <Banner variant="error" title="Couldn't load approvals">{error}</Banner>
        </View>
      )}

      {loading && !data ? (
        <View style={styles.loading}>
          <Spinner label="Loading…" />
        </View>
      ) : (
        <FlatList
          data={listData}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32, gap: 10 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.muted} />}
          renderItem={({ item }) => {
            const post = data?.postsById.get(item.postId);
            const meta = APPROVAL_STATUS_META[item.status] ?? { label: item.status, variant: 'outline' as const };
            return (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={styles.cardTop}>
                  <Badge variant={meta.variant}>{meta.label}</Badge>
                  <Text style={[styles.cardDate, { color: colors.muted }]}>{formatDateTime(item.createdAt)}</Text>
                </View>
                <Text
                  style={[styles.cardContent, { color: colors.text }]}
                  numberOfLines={3}
                  onPress={() => router.push(`/post/${item.postId}`)}
                >
                  {post?.title || post?.content || 'View post…'}
                </Text>
                {!!item.decisionNotes && (
                  <Text style={[styles.notes, { color: colors.mutedForeground }]} numberOfLines={2}>
                    “{item.decisionNotes}”
                  </Text>
                )}
                {item.status === 'pending' && (
                  <View style={styles.actions}>
                    <Button
                      title="Reject"
                      variant="outline"
                      size="sm"
                      onPress={() => openDecision(item, 'rejected')}
                    />
                    <Button title="Approve" size="sm" onPress={() => openDecision(item, 'approved')} />
                  </View>
                )}
              </View>
            );
          }}
          ListEmptyComponent={
            <EmptyState
              icon={<BadgeCheck size={40} color={colors.mutedForeground} />}
              title={segment === 'pending' ? 'Nothing to review' : 'No decisions yet'}
              description={
                segment === 'pending'
                  ? 'Posts submitted for approval will show up here.'
                  : 'Approved and rejected posts appear here.'
              }
            />
          }
        />
      )}

      <Sheet
        visible={decision !== null}
        onClose={() => setDecision(null)}
        title={decision?.status === 'approved' ? 'Approve post' : 'Reject post'}
      >
        <View style={{ gap: 12 }}>
          <Textarea
            label="Notes"
            placeholder={decision?.status === 'approved' ? 'Optional' : 'Why is this rejected?'}
            value={notes}
            onChangeText={setNotes}
          />
          <Button
            title={decision?.status === 'approved' ? 'Approve' : 'Reject'}
            variant={decision?.status === 'rejected' ? 'destructive' : 'primary'}
            onPress={submitDecision}
            loading={deciding}
            fullWidth
          />
        </View>
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 16, paddingBottom: 12 },
  title: { fontSize: 34, fontWeight: '700' },
  segment: { paddingHorizontal: 16, marginBottom: 4 },
  bannerWrap: { paddingHorizontal: 16, paddingTop: 8 },
  loading: { paddingTop: 64, alignItems: 'center' },
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 8 },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardDate: { fontSize: 12 },
  cardContent: { fontSize: 15, lineHeight: 21 },
  notes: { fontSize: 13, fontStyle: 'italic' },
  actions: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end', marginTop: 2 },
});
