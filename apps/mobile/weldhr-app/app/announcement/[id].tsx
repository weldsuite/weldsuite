/**
 * One announcement, opened from the list or from its push notification: the
 * title, who posted it and when, then the full text with its line breaks.
 * Opening an unread one marks it read, which clears the dot and the count on
 * the tab.
 */

import { useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Pin } from 'lucide-react-native';
import type { HrSelfAnnouncement } from '@weldsuite/app-api-client/domains/weldhr';

import { EmptyState } from '@/components/EmptyState';
import { MyHrGate, useSelfState } from '@/components/MyHrGate';
import { QueryBody } from '@/components/QueryBody';
import { Screen } from '@/components/Screen';
import { usePalette } from '@/hooks/use-palette';
import { useAnnouncements, useMarkAnnouncementRead } from '@/hooks/use-weldhr-queries';
import { formatDate, formatTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

export default function AnnouncementScreen() {
  const { t } = useI18n();
  const { id } = useLocalSearchParams<{ id: string }>();
  const state = useSelfState();
  const announcements = useAnnouncements(state.status === 'ready');

  const refresh = () => {
    state.refetch();
    void announcements.refetch();
  };

  return (
    <Screen title={t.announcements.details} variant="push" plain refreshing={announcements.isRefetching} onRefresh={refresh}>
      <MyHrGate state={state} onRetry={refresh}>
        <QueryBody query={announcements}>
          {(data) => {
            const announcement = data.announcements.find((a) => a.id === id);
            return announcement ? (
              <Article announcement={announcement} />
            ) : (
              <EmptyState illustration="chat" title={t.announcements.notFound} />
            );
          }}
        </QueryBody>
      </MyHrGate>
    </Screen>
  );
}

function Article({ announcement }: Readonly<{ announcement: HrSelfAnnouncement }>) {
  const palette = usePalette();
  const { t, format, intlLocale } = useI18n();
  const { mutate: markRead } = useMarkAnnouncementRead();
  const marked = useRef<string | null>(null);

  // Opening an unread one marks it read, once; a failed call is tried again the next time it is opened.
  useEffect(() => {
    if (announcement.readAt != null || marked.current === announcement.id) return;
    marked.current = announcement.id;
    markRead(announcement.id);
  }, [announcement.id, announcement.readAt, markRead]);

  const meta = [
    announcement.createdByName ? format(t.announcements.by, { name: announcement.createdByName }) : null,
    `${formatDate(announcement.publishedAt, intlLocale)}, ${formatTime(announcement.publishedAt, intlLocale)}`,
  ].filter(Boolean);

  return (
    <View style={styles.article}>
      {announcement.pinned ? (
        <View style={[styles.pinned, { backgroundColor: palette.tile }]}>
          <Pin size={13} color={palette.muted} strokeWidth={2.2} />
          <Text style={[styles.pinnedText, { color: palette.muted }]}>{t.announcements.pinned}</Text>
        </View>
      ) : null}
      <Text style={[styles.title, { color: palette.text }]} accessibilityRole="header">
        {announcement.title}
      </Text>
      <Text style={[styles.meta, { color: palette.muted }]}>{meta.join(' · ')}</Text>
      {/* Plain text; its line breaks are the author's. */}
      <Text style={[styles.body, { color: palette.text }]} selectable>
        {announcement.body}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  article: { paddingHorizontal: 16, paddingTop: 4, gap: 10 },
  pinned: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  pinnedText: { fontSize: 13, fontWeight: '600' },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '700', letterSpacing: -0.4 },
  meta: { fontSize: 14, lineHeight: 20 },
  body: { fontSize: 17, lineHeight: 25, marginTop: 8 },
});
