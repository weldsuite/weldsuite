import { useCallback } from 'react';
import { usePathname, useSearchParams } from '@/lib/router';
import type { MenuGroupProps } from '@/components/app-sidebar-layout';
import type { InboxAssigneeFilter } from '@/app/welddesk/inbox/conversation-list';

const INBOX_PATH = '/welddesk/inbox';

// The sidebar's three inbox views share one path and differ by `?assignee=`,
// which the sidebar's path-based matching can't tell apart.
const INBOX_VIEW_BY_HREF: Record<string, InboxAssigneeFilter> = {
  [INBOX_PATH]: 'all',
  [`${INBOX_PATH}?assignee=mine`]: 'mine',
  [`${INBOX_PATH}?assignee=unassigned`]: 'unassigned',
};

// Channel inboxes have their own paths and sidebar items.
const CHANNEL_SEGMENTS = new Set(['chat', 'email', 'phone']);

export function readInboxAssignee(value: string | null): InboxAssigneeFilter {
  return value === 'mine' || value === 'unassigned' ? value : 'all';
}

/**
 * Marks the active inbox view in the WeldDesk sidebar: the inbox, or a
 * conversation opened from it, under the `?assignee=` it was opened with.
 */
export function useWelddeskSidebarItems(enabled: boolean) {
  const pathname = usePathname();
  const assignee = readInboxAssignee(useSearchParams().get('assignee'));

  const adjust = useCallback(
    (groups: MenuGroupProps[]): MenuGroupProps[] => {
      if (!enabled) return groups;
      const segment = pathname.startsWith(`${INBOX_PATH}/`) ? pathname.split('/')[3] : undefined;
      const inInbox = pathname === INBOX_PATH || (segment !== undefined && !CHANNEL_SEGMENTS.has(segment));
      return groups.map((group) => ({
        ...group,
        items: group.items.map((item) => {
          const view = INBOX_VIEW_BY_HREF[item.href];
          return view ? { ...item, isActive: inInbox && view === assignee } : item;
        }),
      }));
    },
    [enabled, pathname, assignee],
  );

  return { adjust };
}
