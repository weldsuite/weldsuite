import { BreadcrumbHeader, BreadcrumbSegment } from '@/components/breadcrumb-header';
import { useCurrentBreadcrumbs } from '@/contexts/breadcrumb-context';
import { getTranslations } from '@/lib/i18n';

interface AgentsHeaderProps {
  onWeldAgentToggle?: (isOpen: boolean) => void;
  onCalendarToggle?: (isOpen: boolean) => void;
  onNotificationsToggle?: (isOpen: boolean) => void;
}

export function AgentsHeader({
  onWeldAgentToggle,
  onCalendarToggle,
  onNotificationsToggle,
}: AgentsHeaderProps) {
  const t = getTranslations('common');
  const contextBreadcrumbs = useCurrentBreadcrumbs();

  const segments: BreadcrumbSegment[] =
    contextBreadcrumbs.length > 0
      ? contextBreadcrumbs
      : [{ label: t.agents.pageTitle, href: '/agents' }];

  return (
    <BreadcrumbHeader
      segments={segments}
      onWeldAgentToggle={onWeldAgentToggle}
      onCalendarToggle={onCalendarToggle}
      onNotificationsToggle={onNotificationsToggle}
      moduleKey="agents"
    />
  );
}
