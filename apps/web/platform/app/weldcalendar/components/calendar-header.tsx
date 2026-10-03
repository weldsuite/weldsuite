
import { usePathname } from '@/lib/router';
import { BreadcrumbHeader, type BreadcrumbSegment } from '@/components/breadcrumb-header';
import { getTranslations } from '@/lib/i18n';
import { useBookingPage } from '@/hooks/queries/use-calendar-queries';
import { buildCalendarBreadcrumbs, schedulingPageIdFromPath } from '../lib/calendar-breadcrumbs';

interface CalendarHeaderProps {
  onWeldAgentToggle?: (isOpen: boolean) => void;
  onCalendarToggle?: (isOpen: boolean) => void;
  onNotificationsToggle?: (isOpen: boolean) => void;
}

export function CalendarHeader({ onWeldAgentToggle, onCalendarToggle, onNotificationsToggle }: Readonly<CalendarHeaderProps>) {
  const t = getTranslations('weldcalendar');
  const pathname = usePathname();

  // Booking page routes show the page's name, not its id (cached by the page itself).
  const { data: bookingPageData } = useBookingPage(schedulingPageIdFromPath(pathname) ?? '');

  const segments: BreadcrumbSegment[] = buildCalendarBreadcrumbs(pathname, {
    bookingPageName: bookingPageData?.data?.name,
    labels: {
      root: t.calendarSidebar.breadcrumb,
      scheduling: t.scheduling.title,
      newBookingPage: t.misc.newBookingPage,
      bookingPage: t.misc.defaultBookingPage,
      details: t.bookingEditor.tabDetails,
      edit: t.bookingView.edit,
    },
  });

  return (
    <BreadcrumbHeader
      segments={segments}
      onWeldAgentToggle={onWeldAgentToggle}
      onCalendarToggle={onCalendarToggle}
      onNotificationsToggle={onNotificationsToggle}
      moduleKey="calendar"
    />
  );
}
