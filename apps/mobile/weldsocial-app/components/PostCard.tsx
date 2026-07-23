import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useTheme } from '@weldsuite/mobile-ui/contexts/ThemeContext';
import { Badge } from '@weldsuite/mobile-ui/components/Badge';
import { Clock, Image as ImageIcon } from 'lucide-react-native';
import type { SocialAccount, SocialPost } from '@weldsuite/app-api-client/domains/social';
import { PLATFORM_META, POST_STATUS_META, formatDateTime } from '@/lib/social';

interface PostCardProps {
  post: SocialPost;
  /** Accounts keyed by id, used to render platform dots for the post's targets. */
  accountsById?: Map<string, SocialAccount>;
  onPress: () => void;
}

export function PostCard({ post, accountsById, onPress }: PostCardProps) {
  const { colors } = useTheme();
  const status = POST_STATUS_META[post.status] ?? { label: post.status, variant: 'outline' as const };
  const targets = (post.targetAccountIds ?? [])
    .map((id) => accountsById?.get(id))
    .filter((a): a is SocialAccount => !!a);
  const when = post.status === 'published' ? post.publishedAt : post.scheduledAt;
  const mediaCount = post.mediaIds?.length ?? 0;

  return (
    <TouchableOpacity
      style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.topRow}>
        <View style={styles.platformDots}>
          {targets.length > 0 ? (
            targets.map((account) => (
              <View
                key={account.id}
                style={[styles.dot, { backgroundColor: PLATFORM_META[account.platform]?.color ?? colors.muted }]}
              />
            ))
          ) : (
            <View style={[styles.dot, { backgroundColor: colors.border }]} />
          )}
        </View>
        <Badge variant={status.variant}>{status.label}</Badge>
      </View>

      {!!post.title && (
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
          {post.title}
        </Text>
      )}
      <Text style={[styles.content, { color: post.title ? colors.mutedForeground : colors.text }]} numberOfLines={2}>
        {post.content || 'No content yet'}
      </Text>

      <View style={styles.bottomRow}>
        {!!when && (
          <View style={styles.meta}>
            <Clock size={13} color={colors.muted} />
            <Text style={[styles.metaText, { color: colors.muted }]}>{formatDateTime(when)}</Text>
          </View>
        )}
        {mediaCount > 0 && (
          <View style={styles.meta}>
            <ImageIcon size={13} color={colors.muted} />
            <Text style={[styles.metaText, { color: colors.muted }]}>{mediaCount}</Text>
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 6 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  platformDots: { flexDirection: 'row', gap: 4 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  title: { fontSize: 16, fontWeight: '600' },
  content: { fontSize: 14, lineHeight: 20 },
  bottomRow: { flexDirection: 'row', gap: 14, marginTop: 2 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaText: { fontSize: 12 },
});
