import { TeamMemberDetailsPanel, fromTeamMember } from '@/components/team-member-details-panel';
import type { TeamMember } from './team-section';

export interface MemberDetailPanelProps {
  member: TeamMember | null;
  isOpen: boolean;
  onClose: () => void;
  canManageMembers: boolean;
  onRemoveMember: (memberId: string) => void;
  onMemberUpdated: () => void;
  /** When provided, clicking the Maximize button calls this instead of toggling internal state. */
  onExpand?: (memberId: string) => void;
  /** When provided, the in-expanded collapse button calls this instead of toggling internal state. */
  onCollapse?: () => void;
  /** Initial expanded state for the panel. Defaults to false (collapsed side panel). */
  defaultExpanded?: boolean;
  /** Skip the slide-in mount animation. Useful when arriving via route navigation
   * after a width-grow animation on the previous route, to avoid a double animation. */
  skipAnimation?: boolean;
}

export function MemberDetailPanel({
  member,
  isOpen,
  onClose,
  canManageMembers,
  onRemoveMember,
  onMemberUpdated,
  onExpand,
  onCollapse,
  defaultExpanded,
  skipAnimation,
}: MemberDetailPanelProps) {
  return (
    <TeamMemberDetailsPanel
      member={member ? fromTeamMember(member) : null}
      isOpen={isOpen}
      onClose={onClose}
      canManageMembers={canManageMembers}
      onRemoveMember={onRemoveMember}
      onMemberUpdated={onMemberUpdated}
      context="settings"
      onExpand={onExpand}
      onCollapse={onCollapse}
      defaultExpanded={defaultExpanded}
      skipAnimation={skipAnimation}
    />
  );
}
