/**
 * An announcement in a list: its tile (a pin for a pinned one, a megaphone for
 * the rest), the title over the start of the text, and when it was published
 * on the right; on a light blue while unread.
 */

import { Megaphone, Pin } from 'lucide-react-native';
import type { HrSelfAnnouncement } from '@weldsuite/app-api-client/domains/weldhr';

import { usePalette } from '@/hooks/use-palette';
import { ageOf, bodyPreview } from '@/lib/announcements';
import { formatDate } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { IconTile, Row } from './Row';

/** "11m", "3h", "Yesterday", "4d", or the date once it is a week old. */
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
      // White on the light blue of an unread row, where the grey tile would fade into it.
      leading={<IconTile icon={announcement.pinned ? Pin : Megaphone} background={unread ? palette.surface : undefined} />}
      top
      unread={unread}
      title={announcement.title}
      subtitle={bodyPreview(announcement.body)}
      subtitleLines={2}
      value={ageLabel(announcement.publishedAt)}
      smallValue
      onPress={onPress}
      testID={`announcement-${announcement.id}`}
    />
  );
}
