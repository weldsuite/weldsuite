
import { usePathname } from '@/lib/router';
import { BreadcrumbHeader, BreadcrumbSegment } from '@/components/breadcrumb-header';
import { useCurrentBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useI18n } from '@/lib/i18n/provider';

interface HelpdeskHeaderProps {
  onWeldAgentToggle?: (isOpen: boolean) => void;
  onCalendarToggle?: (isOpen: boolean) => void;
  onNotificationsToggle?: (isOpen: boolean) => void;
}

type HelpdeskTranslations = ReturnType<typeof useI18n>['t'];

function getSegmentLabel(part: string, t: HelpdeskTranslations): string {
  const labels: Record<string, string> = {
    'chat-widget': t.helpdesk.chatWidget.title,
    inbox: t.navigation.moduleSidebar.welddesk.inbox,
    email: t.navigation.moduleSidebar.welddesk.email,
    'help-center': t.navigation.moduleSidebar.welddesk.helpCenter,
    articles: t.navigation.moduleSidebar.welddesk.articles,
  };
  return Object.hasOwn(labels, part)
    ? labels[part]
    : part.charAt(0).toUpperCase() + part.slice(1).replace(/-/g, ' ');
}

function buildPathSegments(pathname: string, t: HelpdeskTranslations): BreadcrumbSegment[] {
  const segments: BreadcrumbSegment[] = [{ label: t.helpdesk.title, href: '/welddesk/inbox' }];
  const pathParts = pathname.split('/').filter(Boolean);
  for (let i = 1; i < pathParts.length; i++) {
    segments.push({
      label: getSegmentLabel(pathParts[i], t),
      href: '/' + pathParts.slice(0, i + 1).join('/'),
    });
  }
  return segments;
}

export function HelpdeskHeader({ onWeldAgentToggle, onCalendarToggle, onNotificationsToggle }: Readonly<HelpdeskHeaderProps>) {
  const pathname = usePathname();
  const contextBreadcrumbs = useCurrentBreadcrumbs();
  const { t } = useI18n();

  // Use context breadcrumbs if a page has set them, otherwise build from pathname
  const segments =
    contextBreadcrumbs.length > 0 ? contextBreadcrumbs : buildPathSegments(pathname, t);

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
