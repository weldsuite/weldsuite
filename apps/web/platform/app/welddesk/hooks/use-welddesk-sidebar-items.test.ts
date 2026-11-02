import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { Inbox } from 'lucide-react';
import type { MenuGroupProps } from '@/components/app-sidebar-layout';
import { useWelddeskSidebarItems } from './use-welddesk-sidebar-items';

const location = { pathname: '/welddesk/inbox', search: '' };

vi.mock('@/lib/router', () => ({
  usePathname: () => location.pathname,
  useSearchParams: () => new URLSearchParams(location.search),
}));

const groups: MenuGroupProps[] = [
  {
    group: 'Inbox',
    items: [
      { title: 'All open', href: '/welddesk/inbox', icon: Inbox },
      { title: 'Assigned to me', href: '/welddesk/inbox?assignee=mine', icon: Inbox },
      { title: 'Unassigned', href: '/welddesk/inbox?assignee=unassigned', icon: Inbox },
    ],
  },
  {
    group: 'Channels',
    items: [{ title: 'Chat', href: '/welddesk/inbox/chat', icon: Inbox }],
  },
];

function activeTitles(pathname: string, search = ''): string[] {
  location.pathname = pathname;
  location.search = search;
  const { result } = renderHook(() => useWelddeskSidebarItems(true));
  return result.current
    .adjust(groups)
    .flatMap((group) => group.items)
    .filter((item) => item.isActive)
    .map((item) => item.title);
}

describe('useWelddeskSidebarItems', () => {
  beforeEach(() => {
    location.pathname = '/welddesk/inbox';
    location.search = '';
  });

  it('marks "All open" on the plain inbox', () => {
    expect(activeTitles('/welddesk/inbox')).toEqual(['All open']);
  });

  it('marks the assignee view the inbox is filtered to', () => {
    expect(activeTitles('/welddesk/inbox', '?assignee=mine')).toEqual(['Assigned to me']);
    expect(activeTitles('/welddesk/inbox', '?assignee=unassigned')).toEqual(['Unassigned']);
  });

  it('keeps the view marked while a conversation from it is open', () => {
    expect(activeTitles('/welddesk/inbox/conv_123', '?assignee=mine')).toEqual(['Assigned to me']);
  });

  it('leaves the inbox views unmarked in a channel inbox', () => {
    // The Chat item itself is matched by path in the sidebar, not here.
    expect(activeTitles('/welddesk/inbox/chat/conv_123')).toEqual([]);
  });

  it('changes nothing when WeldDesk is not the open module', () => {
    location.pathname = '/weldcrm';
    const { result } = renderHook(() => useWelddeskSidebarItems(false));
    expect(result.current.adjust(groups)).toBe(groups);
  });
});
