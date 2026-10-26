/**
 * The Announcements tab: what HR posted for everyone, pinned ones first, with
 * a dot on the ones not opened yet. Tap one to read it (and mark it read).
 */

import { useRouter } from 'expo-router';

import { AnnouncementRow } from '@/components/AnnouncementRow';
import { EmptyState } from '@/components/EmptyState';
import { MyHrGate, useSelfState } from '@/components/MyHrGate';
import { QueryBody } from '@/components/QueryBody';
import { List } from '@/components/Row';
import { Screen } from '@/components/Screen';
import { useAnnouncements } from '@/hooks/use-weldhr-queries';
import { sortAnnouncements } from '@/lib/announcements';
import { useI18n } from '@/lib/i18n';

export default function AnnouncementsScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const state = useSelfState();
  const announcements = useAnnouncements(state.status === 'ready');

  const refresh = () => {
    state.refetch();
    void announcements.refetch();
  };

  return (
    <Screen
      title={t.announcements.title}
      refreshing={state.isRefetching || announcements.isRefetching}
      onRefresh={refresh}
    >
      <MyHrGate state={state} onRetry={refresh}>
        <QueryBody query={announcements}>
          {({ announcements: list }) =>
            list.length === 0 ? (
              <EmptyState illustration="chat" title={t.announcements.empty} description={t.announcements.emptyDescription} />
            ) : (
              <List>
                {sortAnnouncements(list).map((announcement) => (
                  <AnnouncementRow
                    key={announcement.id}
                    announcement={announcement}
                    onPress={() => router.push({ pathname: '/announcement/[id]', params: { id: announcement.id } })}
                  />
                ))}
              </List>
            )
          }
        </QueryBody>
      </MyHrGate>
    </Screen>
  );
}
