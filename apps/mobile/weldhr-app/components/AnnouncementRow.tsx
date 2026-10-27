/**
 * An announcement in a list: its tile (a pin for a pinned one, a megaphone for
 * the rest, with a dot while unread), the title over the start of the text,
 * and when it was published and by whom on the right.
 */

import { StyleSheet, View } from 'react-native';
import { Megaphone, Pin } from 'lucide-react-native';
import type { HrSelfAnnouncement } from '@weldsuite/app-api-client/domains/weldhr';

import { usePalette } from '@/hooks/use-palette';
import { ageOf, bodyPreview } from '@/lib/announcements';
import { formatDate } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { IconTile, Row } from './Row';

/** "3 h ago", "Yesterday", or the date once it is a week old. */
export function useAgeLabel(): (publishedAt: string) => string {
  const { t, format, intlLocale } = useI18n();
  return (publishedAt) => {
    const age = ageOf(publishedAt);
    switch (age.kind) {
      case 'now':
        return t.announcements.justNow;
      case 'minutes':
        return format(t.announcements.minutesAgo, { count: age.count });
      case 'hours':
        return format(t.announcements.hoursAgo, { count: age.count });
      case 'yesterday':
        return t.announcements.yesterday;
      case 'days':
        return format(t.announcements.daysAgo, { count: age.count });
      default:
        return formatDate(publishedAt, intlLocale);
    }
  };
}

export function AnnouncementRow({
  announcement,
  onPress,
}: Readonly<{ announcement: HrSelfAnnouncement; onPress: () => void }>) {
  const palette = usePalette();
  const ageLabel = useAgeLabel();
  const unread = announcement.readAt == null;

  return (
    <Row
      leading={
        <View>
          <IconTile icon={announcement.pinned ? Pin : Megaphone} />
          {unread ? <View style={[styles.dot, { backgroundColor: palette.accent, borderColor: palette.surface }]} /> : null}
        </View>
      }
      title={announcement.title}
      subtitle={bodyPreview(announcement.body)}
      subtitleLines={2}
      value={ageLabel(announcement.publishedAt)}
      detail={announcement.createdByName ?? undefined}
      detailColor={palette.muted}
      onPress={onPress}
      testID={`announcement-${announcement.id}`}
    />
  );
}

const styles = StyleSheet.create({
  dot: { position: 'absolute', top: -3, right: -3, width: 12, height: 12, borderRadius: 6, borderWidth: 2 },
});
