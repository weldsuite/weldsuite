
import { usePathname } from '@/lib/router';
import { BreadcrumbHeader, type BreadcrumbSegment } from '@/components/breadcrumb-header';
import { useI18n } from '@/lib/i18n/provider';

interface DashboardHeaderProps {
  onWeldAgentToggle?: (isOpen: boolean) => void;
  onCalendarToggle?: (isOpen: boolean) => void;
  onNotificationsToggle?: (isOpen: boolean) => void;
}

export function DashboardHeader({ onWeldAgentToggle, onCalendarToggle, onNotificationsToggle }: DashboardHeaderProps) {
  const pathname = usePathname();
  const { t } = useI18n();

  // Generate breadcrumb segments based on the current path. The root anchor
  // points to `/` (the WeldSuite home) — the legacy `/dashboard` page has
  // been removed; this header is now shared only by checkout pages.
  const segments: BreadcrumbSegment[] = [
    { label: t.dashboard.title, href: '/' },
  ];

  // Parse pathname to create breadcrumbs dynamically
  const pathParts = pathname.split('/').filter(Boolean);
  if (pathParts.length > 1) {
    // Skip first part (route group root)
    for (let i = 1; i < pathParts.length; i++) {
      const part = pathParts[i];
      const href = '/' + pathParts.slice(0, i + 1).join('/');

      // Capitalize and format the label
      const label = part
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');

      segments.push({ label, href });
    }
  }

  return (
    <BreadcrumbHeader
      segments={segments}
      showBackButton={pathParts.length > 1}
      onWeldAgentToggle={onWeldAgentToggle}
      onCalendarToggle={onCalendarToggle}
      onNotificationsToggle={onNotificationsToggle}
      moduleKey="dashboard"
    />
  );
}
