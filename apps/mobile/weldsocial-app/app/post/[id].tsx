import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useObserve } from 'expo-observe';
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
import { appApi } from '@/services/app-api';
import { useAsyncData } from '@/hooks/use-async-data';
import { useI18n } from '@/lib/i18n';
import { PLATFORM_META, POST_STATUS_VARIANT, formatDateTime, statusBadge } from '@/lib/social';
import { hideAppSplash } from '@/utils/splash';

interface PostDetailData {
  post: SocialPost;
  accounts: SocialAccount[];
}

interface TargetsListProps {
  post: SocialPost;
  accountsById: Map<string, SocialAccount>;
}

/** "Name (@username)" for a known account, else the raw account id. */
function targetLabel(account: SocialAccount | undefined, accountId: string): string {
  if (!account) return accountId;
  const handle = account.username ? ` (@${account.username})` : '';
  return `${account.name}${handle}`;
}

function TargetsList({ post, accountsById }: Readonly<TargetsListProps>) {
  const { colors } = useTheme();
  const { t } = useI18n();
  if (!(post.targetAccountIds ?? []).length) {
    return <Text style={{ color: colors.mutedForeground }}>{t.post.noTargets}</Text>;
  }
  return (
    <View style={{ gap: 8 }}>
      {post.targetAccountIds.map((accountId) => {
        const account = accountsById.get(accountId);
        const meta = account ? PLATFORM_META[account.platform] : null;
        const platformResult = post.platformContent?.find((p) => p.accountId === accountId);
        return (
          <View key={accountId} style={styles.targetRow}>
            <View style={[styles.platformDot, { backgroundColor: meta?.color ?? colors.muted }]} />
            <Text style={[styles.targetName, { color: colors.text }]} numberOfLines={1}>
              {targetLabel(account, accountId)}
            </Text>
            {platformResult?.publishedUrl && (
              <TouchableOpacity
                onPress={() => Linking.openURL(platformResult.publishedUrl!)}
                accessibilityRole="button"
                accessibilityLabel={t.post.openPublished}
              >
                <ExternalLink size={16} color={colors.info} />
              </TouchableOpacity>
            )}
          </View>
        );
      })}
    </View>
  );
}

export default function PostDetailScreen() {
  const { colors } = useTheme();
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { markInteractive } = useObserve();
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

  useEffect(() => {
    if (!loading) {
      hideAppSplash();
      markInteractive();
    }
  }, [loading, markInteractive]);

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
      toast.error(err instanceof Error ? err.message : t.post.actionFailed);
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = () =>
    runAction('delete', async () => {
      await appApi.social.posts.remove(postId);
      router.back();
    }, t.post.deleted);

  const status = post ? statusBadge(POST_STATUS_VARIANT, t.postStatus, post.status) : null;
  const isEditable = post ? ['draft', 'pending_approval', 'approved', 'failed', 'cancelled'].includes(post.status) : false;
  const canPublish = post ? ['draft', 'approved', 'failed', 'cancelled'].includes(post.status) : false;
  const canCancel = post ? post.status === 'scheduled' : false;
  // Publishing needs somewhere to publish to: the composer enforces the same.
  const hasTargets = (post?.targetAccountIds ?? []).length > 0;

  const renderBody = () => {
    if (loading && !post) {
      return (
        <View style={styles.loading}>
          <Spinner label={t.common.loading} />
        </View>
      );
    }
    if (error && !post) {
      return (
        <View style={styles.bannerWrap}>
          <Banner variant="error" title={t.post.loadError}>{error}</Banner>
        </View>
      );
    }
    if (!post) return null;
    return (
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32, gap: 16 }}>
        <View style={styles.statusRow}>
          {status && <Badge variant={status.variant} label={status.label} />}
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
        <Text style={[styles.content, { color: colors.text }]}>{post.content || t.post.noContent}</Text>

        <Divider />

        <View>
          <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>{t.post.targets}</Text>
          <TargetsList post={post} accountsById={accountsById} />
        </View>

        {post.status === 'failed' && (
          <Banner variant="error" title={t.post.publishFailedTitle}>
            {t.post.publishFailedBody}
          </Banner>
        )}

        <View style={{ gap: 10 }}>
          {canPublish && !hasTargets && (
            <Text style={[styles.hint, { color: colors.mutedForeground }]}>{t.post.noTargetsHint}</Text>
          )}
          {canPublish && (
            <Button
              title={t.post.publishNow}
              onPress={() => runAction('publish', () => appApi.social.posts.publish(postId), t.post.published)}
              loading={busy === 'publish'}
              disabled={busy !== null || !hasTargets}
              fullWidth
            />
          )}
          {isEditable && (
            <Button
              title={t.post.editPost}
              variant="secondary"
              onPress={() => router.push(`/compose?id=${postId}`)}
              disabled={busy !== null}
              fullWidth
            />
          )}
          {canCancel && (
            <Button
              title={t.post.cancelScheduled}
              variant="outline"
              onPress={() => setConfirm('cancel')}
              disabled={busy !== null}
              loading={busy === 'cancel'}
              fullWidth
            />
          )}
          {post.status !== 'published' && (
            <Button
              title={t.post.deletePost}
              variant="destructive"
              onPress={() => setConfirm('delete')}
              disabled={busy !== null}
              loading={busy === 'delete'}
              fullWidth
            />
          )}
        </View>
      </ScrollView>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8, borderBottomColor: colors.divider }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerButton} accessibilityRole="button" accessibilityLabel={t.common.back}>
          <ArrowLeft size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>{t.post.title}</Text>
        {isEditable ? (
          <TouchableOpacity
            onPress={() => router.push(`/compose?id=${postId}`)}
            style={styles.headerButton}
            accessibilityRole="button"
            accessibilityLabel={t.common.edit}
          >
            <Pencil size={20} color={colors.text} />
          </TouchableOpacity>
        ) : (
          <View style={styles.headerButton} />
        )}
      </View>

      {renderBody()}

      <ConfirmModal
        visible={confirm === 'cancel'}
        title={t.post.cancelConfirmTitle}
        message={t.post.cancelConfirmMessage}
        confirmText={t.post.cancelConfirmAction}
        cancelText={t.post.keepPost}
        variant="destructive"
        onConfirm={() => {
          setConfirm(null);
          void runAction('cancel', () => appApi.social.posts.cancel(postId), t.post.cancelled);
        }}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmModal
        visible={confirm === 'delete'}
        title={t.post.deleteConfirmTitle}
        message={t.post.deleteConfirmMessage}
        confirmText={t.post.deleteConfirmAction}
        cancelText={t.post.cancel}
        variant="destructive"
        onConfirm={() => {
          setConfirm(null);
          void handleDelete();
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
  hint: { fontSize: 13, textAlign: 'center' },
  title: { fontSize: 22, fontWeight: '700' },
  content: { fontSize: 16, lineHeight: 24 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.6,
    marginBottom: 10,
    textTransform: 'uppercase',
  },
  targetRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  platformDot: { width: 10, height: 10, borderRadius: 5 },
  targetName: { flex: 1, fontSize: 15 },
});
