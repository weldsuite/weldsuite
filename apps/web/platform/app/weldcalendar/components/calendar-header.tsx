
import { usePathname } from '@/lib/router';
import { BreadcrumbHeader, type BreadcrumbSegment } from '@/components/breadcrumb-header';
import { getTranslations } from '@/lib/i18n';

interface CalendarHeaderProps {
  onWeldAgentToggle?: (isOpen: boolean) => void;
  onCalendarToggle?: (isOpen: boolean) => void;
  onNotificationsToggle?: (isOpen: boolean) => void;
}

export function CalendarHeader({ onWeldAgentToggle, onCalendarToggle, onNotificationsToggle }: CalendarHeaderProps) {
  const t = getTranslations('weldcalendar');
  const pathname = usePathname();

  const segments: BreadcrumbSegment[] = [
    { label: t.calendarSidebar.breadcrumb, href: '/weldcalendar' }
  ];

  const pathParts = pathname.split('/').filter(Boolean);
  if (pathParts.length > 1) {
    for (let i = 1; i < pathParts.length; i++) {
      const part = pathParts[i];
      const label = part.charAt(0).toUpperCase() + part.slice(1).replace(/-/g, ' ');
      const href = '/' + pathParts.slice(0, i + 1).join('/');
      segments.push({ label, href });
    }
  }

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
