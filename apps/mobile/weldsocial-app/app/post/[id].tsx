import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, Pencil, ExternalLink } from 'lucide-react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { useToast } from '@weldsuite/mobile-ui/contexts/ToastContext';
import { Badge } from '@weldsuite/mobile-ui/components/Badge';
import { Button } from '@weldsuite/mobile-ui/components/Button';
import { Banner } from '@weldsuite/mobile-ui/components/Banner';
import { Spinner } from '@weldsuite/mobile-ui/components/Spinner';
import { ConfirmModal } from '@weldsuite/mobile-ui/components/ConfirmModal';
import { Divider } from '@weldsuite/mobile-ui/components/Divider';
import type { SocialAccount, SocialPost } from '@weldsuite/app-api-client/domains/social';
import appApi from '@/services/app-api';
import { useAsyncData } from '@/hooks/use-async-data';
import { PLATFORM_META, POST_STATUS_META, formatDateTime } from '@/lib/social';

interface PostDetailData {
  post: SocialPost;
  accounts: SocialAccount[];
}

export default function PostDetailScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const { id } = useLocalSearchParams<{ id: string }>();
  const postId = String(id);

  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'cancel' | 'delete' | null>(null);

  const fetcher = useCallback(async (): Promise<PostDetailData> => {
    const [postRes, accountsRes] = await Promise.all([
      appApi.social.posts.get(postId),
      appApi.social.accounts.list({ limit: 100 }),
    ]);
    return { post: postRes.data, accounts: accountsRes.data };
  }, [postId]);

  const { data, loading, error, reload } = useAsyncData(fetcher);
  const post = data?.post ?? null;

  const accountsById = useMemo(
    () => new Map((data?.accounts ?? []).map((a) => [a.id, a])),
    [data?.accounts],
  );

  const runAction = async (name: string, action: () => Promise<unknown>, successMessage: string) => {
    setBusy(name);
    try {
      await action();
      toast.success(successMessage);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = () =>
    runAction('delete', async () => {
      await appApi.social.posts.remove(postId);
      router.back();
    }, 'Post deleted');

  const status = post ? POST_STATUS_META[post.status] ?? { label: post.status, variant: 'outline' as const } : null;
  const isEditable = post ? ['draft', 'pending_approval', 'approved', 'failed', 'cancelled'].includes(post.status) : false;
  const canPublish = post ? ['draft', 'approved', 'failed', 'cancelled'].includes(post.status) : false;
  const canCancel = post ? post.status === 'scheduled' : false;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: colors.divider }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerButton} accessibilityLabel="Back">
          <ArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Post</Text>
        {isEditable ? (
          <TouchableOpacity
            onPress={() => router.push(`/compose?id=${postId}`)}
            style={styles.headerButton}
            accessibilityLabel="Edit"
          >
            <Pencil size={20} color={colors.text} />
          </TouchableOpacity>
        ) : (
          <View style={styles.headerButton} />
        )}
      </View>

      {loading && !post ? (
        <View style={styles.loading}>
          <Spinner label="Loading…" />
        </View>
      ) : error && !post ? (
        <View style={styles.bannerWrap}>
          <Banner variant="error" title="Couldn't load post">{error}</Banner>
        </View>
      ) : post ? (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32, gap: 16 }}>
          <View style={styles.statusRow}>
            {status && <Badge variant={status.variant}>{status.label}</Badge>}
            {!!post.scheduledAt && post.status === 'scheduled' && (
              <Text style={[styles.when, { color: colors.mutedForeground }]}>
                {formatDateTime(post.scheduledAt)}
              </Text>
            )}
            {!!post.publishedAt && post.status === 'published' && (
              <Text style={[styles.when, { color: colors.mutedForeground }]}>
                {formatDateTime(post.publishedAt)}
              </Text>
            )}
          </View>

          {!!post.title && <Text style={[styles.title, { color: colors.text }]}>{post.title}</Text>}
          <Text style={[styles.content, { color: colors.text }]}>{post.content || 'No content'}</Text>

          <Divider />

          <View>
            <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>TARGETS</Text>
            {(post.targetAccountIds ?? []).length ? (
              <View style={{ gap: 8 }}>
                {post.targetAccountIds.map((accountId) => {
                  const account = accountsById.get(accountId);
                  const meta = account ? PLATFORM_META[account.platform] : null;
                  const platformResult = post.platformContent?.find((p) => p.accountId === accountId);
                  return (
                    <View key={accountId} style={styles.targetRow}>
                      <View style={[styles.platformDot, { backgroundColor: meta?.color ?? colors.muted }]} />
                      <Text style={[styles.targetName, { color: colors.text }]} numberOfLines={1}>
                        {account ? `${account.name}${account.username ? ` (@${account.username})` : ''}` : accountId}
                      </Text>
                      {platformResult?.publishedUrl && (
                        <TouchableOpacity
                          onPress={() => Linking.openURL(platformResult.publishedUrl!)}
                          accessibilityLabel="Open published post"
                        >
                          <ExternalLink size={16} color={colors.info} />
                        </TouchableOpacity>
                      )}
                    </View>
                  );
                })}
              </View>
            ) : (
              <Text style={{ color: colors.mutedForeground }}>No target accounts selected.</Text>
            )}
          </View>

          {post.status === 'failed' && (
            <Banner variant="error" title="Last publish failed">
              Check the post's targets and try publishing again.
            </Banner>
          )}

          <View style={{ gap: 10 }}>
            {canPublish && (
              <Button
                title="Publish now"
                onPress={() => runAction('publish', () => appApi.social.posts.publish(postId), 'Post published')}
                loading={busy === 'publish'}
                disabled={busy !== null}
                fullWidth
              />
            )}
            {isEditable && (
              <Button
                title="Edit post"
                variant="secondary"
                onPress={() => router.push(`/compose?id=${postId}`)}
                disabled={busy !== null}
                fullWidth
              />
            )}
            {canCancel && (
              <Button
                title="Cancel scheduled post"
                variant="outline"
                onPress={() => setConfirm('cancel')}
                disabled={busy !== null}
                loading={busy === 'cancel'}
                fullWidth
              />
            )}
            {post.status !== 'published' && (
              <Button
                title="Delete post"
                variant="destructive"
                onPress={() => setConfirm('delete')}
                disabled={busy !== null}
                loading={busy === 'delete'}
                fullWidth
              />
            )}
          </View>
        </ScrollView>
      ) : null}

      <ConfirmModal
        visible={confirm === 'cancel'}
        title="Cancel scheduled post?"
        message="The post will no longer be published and any charged credits are refunded."
        confirmText="Cancel post"
        variant="destructive"
        onConfirm={() => {
          setConfirm(null);
          runAction('cancel', () => appApi.social.posts.cancel(postId), 'Post cancelled');
        }}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmModal
        visible={confirm === 'delete'}
        title="Delete post?"
        message="This removes the post from WeldSocial. This can't be undone."
        confirmText="Delete"
        variant="destructive"
        onConfirm={() => {
          setConfirm(null);
          handleDelete();
        }}
        onCancel={() => setConfirm(null)}
      />
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
  bannerWrap: { padding: 16 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  when: { fontSize: 14 },
  title: { fontSize: 22, fontWeight: '700' },
  content: { fontSize: 16, lineHeight: 24 },
  sectionTitle: { fontSize: 12, fontWeight: '700', letterSpacing: 0.6, marginBottom: 10 },
  targetRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  platformDot: { width: 10, height: 10, borderRadius: 5 },
  targetName: { flex: 1, fontSize: 15 },
});
