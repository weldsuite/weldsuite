
import { useMemo } from 'react';
import { usePathname } from '@/lib/router';
import { BreadcrumbHeader, BreadcrumbSegment } from '@/components/breadcrumb-header';
import { useCurrentBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useI18n } from '@/lib/i18n/provider';

interface HostHeaderProps {
  onWeldAgentToggle?: (isOpen: boolean) => void;
  onCalendarToggle?: (isOpen: boolean) => void;
  onNotificationsToggle?: (isOpen: boolean) => void;
}

export function HostHeader({ onWeldAgentToggle, onCalendarToggle, onNotificationsToggle }: HostHeaderProps) {
  const pathname = usePathname();
  const { t } = useI18n();
  const contextBreadcrumbs = useCurrentBreadcrumbs();

  const segments: BreadcrumbSegment[] = useMemo(() => {
    if (contextBreadcrumbs.length > 0) {
      return contextBreadcrumbs;
    }

    const result: BreadcrumbSegment[] = [
      { label: t.host.domainsList.breadcrumbHost, href: '/weldhost' },
    ];

    const pathParts = pathname.split('/').filter(Boolean);
    if (pathParts.length > 1) {
      for (let i = 1; i < pathParts.length; i++) {
        const part = pathParts[i];
        const label = part.charAt(0).toUpperCase() + part.slice(1).replace(/-/g, ' ');
        const href = '/' + pathParts.slice(0, i + 1).join('/');
        result.push({ label, href });
      }
    }

    return result;
  }, [contextBreadcrumbs, pathname, t]);

  return (
    <BreadcrumbHeader
      segments={segments}
      showBackButton={false}
      onWeldAgentToggle={onWeldAgentToggle}
      onCalendarToggle={onCalendarToggle}
      onNotificationsToggle={onNotificationsToggle}
      moduleKey="host"
    />
  );
}
