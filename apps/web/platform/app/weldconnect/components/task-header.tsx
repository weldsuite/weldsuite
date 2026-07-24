
import { usePathname } from '@/lib/router';
import { BreadcrumbHeader, BreadcrumbSegment } from '@/components/breadcrumb-header';
import { useI18n } from '@/lib/i18n/provider';

interface TaskHeaderProps {
  onWeldAgentToggle?: (isOpen: boolean) => void;
  onCalendarToggle?: (isOpen: boolean) => void;
  onNotificationsToggle?: (isOpen: boolean) => void;
}

export function TaskHeader({ onWeldAgentToggle, onCalendarToggle, onNotificationsToggle }: TaskHeaderProps) {
  const { t } = useI18n();
  const pathname = usePathname();

  const segments: BreadcrumbSegment[] = [
    { label: t.weldconnect.breadcrumbs.automation, href: '/weldconnect' }
  ];

  // Build breadcrumbs from pathname
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
      moduleKey="task"
    />
  );
}
