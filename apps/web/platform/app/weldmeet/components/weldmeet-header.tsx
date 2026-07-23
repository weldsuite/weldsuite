import { BreadcrumbHeader } from "@/components/breadcrumb-header";
import { useCurrentBreadcrumbs } from "@/contexts/breadcrumb-context";

interface WeldMeetHeaderProps {
  onWeldAgentToggle?: (isOpen: boolean) => void;
  onCalendarToggle?: (isOpen: boolean) => void;
  onNotificationsToggle?: (isOpen: boolean) => void;
}

export function WeldMeetHeader({
  onWeldAgentToggle,
  onCalendarToggle,
  onNotificationsToggle,
}: WeldMeetHeaderProps) {
  const breadcrumbs = useCurrentBreadcrumbs();

  return (
    <BreadcrumbHeader
      segments={breadcrumbs}
      showBackButton={false}
      onWeldAgentToggle={onWeldAgentToggle}
      onCalendarToggle={onCalendarToggle}
      onNotificationsToggle={onNotificationsToggle}
      moduleKey="weldmeet"
    />
  );
}
