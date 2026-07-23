import { BreadcrumbHeader } from '@/components/breadcrumb-header';
import { useCurrentBreadcrumbs } from '@/contexts/breadcrumb-context';

interface ChatHeaderProps {
  onWeldAgentToggle?: (isOpen: boolean) => void;
  onCalendarToggle?: (isOpen: boolean) => void;
  onNotificationsToggle?: (isOpen: boolean) => void;
}

export function ChatHeader({
  onWeldAgentToggle,
  onCalendarToggle,
  onNotificationsToggle,
}: ChatHeaderProps) {
  const breadcrumbs = useCurrentBreadcrumbs();

  return (
    <BreadcrumbHeader
      segments={breadcrumbs}
      showBackButton={false}
      onWeldAgentToggle={onWeldAgentToggle}
      onCalendarToggle={onCalendarToggle}
      onNotificationsToggle={onNotificationsToggle}
      moduleKey="weldchat"
    />
  );
}
