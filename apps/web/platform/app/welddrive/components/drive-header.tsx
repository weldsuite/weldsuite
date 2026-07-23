import { usePathname } from '@/lib/router';
import { BreadcrumbHeader, BreadcrumbSegment } from '@/components/breadcrumb-header';
import { getTranslations } from '@/lib/i18n';

interface DriveHeaderProps {
  onWeldAgentToggle?: (isOpen: boolean) => void;
  onCalendarToggle?: (isOpen: boolean) => void;
  onNotificationsToggle?: (isOpen: boolean) => void;
}

export function DriveHeader({ onWeldAgentToggle, onCalendarToggle, onNotificationsToggle }: DriveHeaderProps) {
  const pathname = usePathname();
  const t = getTranslations('welddrive');

  const segments: BreadcrumbSegment[] = [
    { label: t.header.drive, href: '/welddrive' }
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
      searchPlaceholder={t.header.searchPlaceholder}
      onWeldAgentToggle={onWeldAgentToggle}
      onCalendarToggle={onCalendarToggle}
      onNotificationsToggle={onNotificationsToggle}
      moduleKey="drive"
    />
  );
}
