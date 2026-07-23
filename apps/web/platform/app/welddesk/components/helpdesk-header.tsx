
import { usePathname } from '@/lib/router';
import { BreadcrumbHeader, BreadcrumbSegment } from '@/components/breadcrumb-header';
import { useCurrentBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useI18n } from '@/lib/i18n/provider';

interface HelpdeskHeaderProps {
  onWeldAgentToggle?: (isOpen: boolean) => void;
  onCalendarToggle?: (isOpen: boolean) => void;
  onNotificationsToggle?: (isOpen: boolean) => void;
}

export function HelpdeskHeader({ onWeldAgentToggle, onCalendarToggle, onNotificationsToggle }: HelpdeskHeaderProps) {
  const pathname = usePathname();
  const contextBreadcrumbs = useCurrentBreadcrumbs();
  const { t } = useI18n();

  // Use context breadcrumbs if a page has set them, otherwise build from pathname
  let segments: BreadcrumbSegment[];
  if (contextBreadcrumbs.length > 0) {
    segments = contextBreadcrumbs;
  } else {
    segments = [{ label: t.helpdesk.title, href: '/welddesk' }];

    // Build breadcrumbs from pathname
    const pathParts = pathname.split('/').filter(Boolean);
    if (pathParts.length > 1) {
      for (let i = 1; i < pathParts.length; i++) {
        const part = pathParts[i];
        let label = part.charAt(0).toUpperCase() + part.slice(1).replace(/-/g, ' ');

        // Custom labels for specific routes
        if (part === 'chat-widget') label = t.helpdesk.chatWidget.title;
        if (part === 'weldagent') label = t.helpdesk.weldAgent.title;

        const href = '/' + pathParts.slice(0, i + 1).join('/');
        segments.push({ label, href });
      }
    }
  }

  return (
    <BreadcrumbHeader
      segments={segments}
      showBackButton={true}
      onWeldAgentToggle={onWeldAgentToggle}
      onCalendarToggle={onCalendarToggle}
      onNotificationsToggle={onNotificationsToggle}
      moduleKey="helpdesk"
    />
  );
}
