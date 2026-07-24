
import React, { useState, useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAtomValue } from 'jotai';
import { getTranslations } from '@/lib/i18n';
import { usePathname } from '@/lib/router';
import { draftBookingPageTitleAtom } from '../lib/draft-booking-page';
import type { MenuGroupProps } from '@/components/app-sidebar-layout';
import {
  useUserCalendars,
  useEnsureDefaultCalendar,
  useBookingPages,
} from '@/hooks/queries/use-calendar-queries';
import { useIntegrationConnections } from '@/hooks/queries/use-integration-queries';
import { CalendarSidebarSection } from '../components/calendar-sidebar-section';
import { MiniCalendar } from '../components/calendar-sidebar-mini-calendar';
import { BookingPagesSidebarSection, type BookingPageSidebarItem } from '../components/booking-pages-sidebar-section';
import { GoogleCalendarSidebarSection } from '../components/google-calendar-sidebar-section';
import { CreateCalendarDialog } from '../components/create-calendar-dialog';

export function useCalendarSidebarItems(enabled: boolean): { menuGroups: MenuGroupProps[]; dialogs?: React.ReactNode } {
  const t = getTranslations('weldcalendar');
  const navigate = useNavigate();
  const pathname = usePathname();
  const { data, isLoading } = useUserCalendars();
  const ensureDefault = useEnsureDefaultCalendar();
  const { data: bookingPagesData } = useBookingPages();
  const { data: integrationConnectionsResult } = useIntegrationConnections();
  const [ensured, setEnsured] = useState(false);
  const [createCalendarOpen, setCreateCalendarOpen] = useState(false);

  const isCreatingBookingPage =
    pathname === '/weldcalendar/scheduling/new' ||
    pathname === '/weldcalendar/scheduling/__draft__';
  const draftTitle = useAtomValue(draftBookingPageTitleAtom);

  const gcalConnected = React.useMemo(() => {
    const connections = integrationConnectionsResult?.data ?? [];
    return connections.some(c => c.provider === 'google_calendar' && c.status !== 'inactive');
  }, [integrationConnectionsResult]);

  // Auto-create default calendar on first load
  useEffect(() => {
    if (enabled && !isLoading && data?.data && data.data.length === 0 && !ensured) {
      setEnsured(true);
      ensureDefault.mutate();
    }
  }, [enabled, isLoading, data, ensured, ensureDefault]);

  const calendars = data?.data || [];
  const bookingPagesRaw = bookingPagesData?.data ?? [];
  // Sort oldest → newest so newly-created pages append at the bottom of the
  // sidebar list (and the draft entry naturally sits at the end).
  const bookingPages = [...bookingPagesRaw].sort((a, b) => {
    const ta = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
    return ta - tb;
  });

  const menuGroups: MenuGroupProps[] = [];

  if (enabled) {
    // Mini calendar at the top
    menuGroups.push({
      group: '',
      customContent: (
        <MiniCalendar
          onDateSelect={(date) => {
            navigate({ to: '/weldcalendar' });
            window.dispatchEvent(new CustomEvent('weldcalendar:navigate-to-date', { detail: { date: date.toISOString() } }));
          }}
        />
      ),
      items: [],
    });

    if (calendars.length > 0) {
      const ownCalendars = calendars.filter((c) => c.isOwn);
      const sharedCalendars = calendars.filter((c) => !c.isOwn);

      menuGroups.push({
        group: t.calendarSidebar.myCalendars,
        customContent: (
          <>
            <CalendarSidebarSection calendars={ownCalendars} />
            <GoogleCalendarSidebarSection isConnected={gcalConnected} />
          </>
        ),
        items: ownCalendars.map((c) => ({ title: c.name, href: `/weldcalendar?calendarId=${c.id}` })),
        onAdd: () => setCreateCalendarOpen(true),
      });

      if (sharedCalendars.length > 0) {
        menuGroups.push({
          group: t.calendarSidebar.sharedWithMe,
          customContent: <CalendarSidebarSection calendars={sharedCalendars} />,
          items: sharedCalendars.map((c) => ({ title: c.name, href: `/weldcalendar?calendarId=${c.id}` })),
        });
      }
    }

    // Booking pages section. The `+` button used to dispatch a custom event
    // that only the main calendar page listened for, so clicks from inside a
    // booking-page view (where calendar-view.tsx isn't mounted) silently
    // dropped on the floor. Navigate directly instead.
    const handleAddBookingPage = () => navigate({ to: '/weldcalendar/scheduling/new' });
    const draftBookingPage: BookingPageSidebarItem | null = isCreatingBookingPage
      ? {
          id: '__draft__',
          name: (draftTitle?.trim() || t.bookingPagesSidebar.newBookingPage),
          slug: '',
          isDraft: true,
        }
      : null;
    const realBookingPages: BookingPageSidebarItem[] = bookingPages
      .filter((bp): bp is typeof bp & { id: string } => !!bp.id)
      .map((bp) => ({ id: bp.id, name: bp.name, slug: bp.slug }));
    const sidebarBookingPages: BookingPageSidebarItem[] = draftBookingPage
      ? [...realBookingPages, draftBookingPage]
      : realBookingPages;
    menuGroups.push({
      group: t.calendarSidebar.bookingPages,
      customContent: <BookingPagesSidebarSection bookingPages={sidebarBookingPages} onAdd={handleAddBookingPage} />,
      items: sidebarBookingPages.map((bp) => ({
        title: bp.name,
        href: bp.isDraft ? '/weldcalendar/scheduling/new' : `/weldcalendar/scheduling/${bp.id}/view`,
      })),
      onAdd: handleAddBookingPage,
    });
  }

  const dialogs = (
    <CreateCalendarDialog open={createCalendarOpen} onOpenChange={setCreateCalendarOpen} />
  );

  return {
    menuGroups,
    dialogs,
  };
}
