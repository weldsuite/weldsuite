
import * as React from 'react';
import { useAuth } from '@clerk/clerk-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { PageLoader } from '@/components/page-loader';
import { TeamSection, type TeamMember } from '@/components/settings';
import {
  useTeamMembers,
  usePendingMembers,
  useRemoveMember,
  useResendInvite,
  useSyncTeamFromClerk,
  teamKeys,
} from '@/hooks/queries/use-team-queries';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from '@/lib/router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { MemberDetailPanel } from '@/components/settings/member-detail-panel';
import { PendingInvitationsSection } from '@/components/settings/pending-invitations-section';
import { AccessDeniedEmptyState } from '@/components/access-denied-empty-state';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import type { Member } from '@weldsuite/core-api-client/schemas/members';

/**
 * Map core-api member response to TeamSection's TeamMember type.
 */
function toTeamMember(member: Member): TeamMember {
  return {
    id: member.id,
    userId: member.userId,
    name: member.name,
    picture: member.picture,
    email: 'email' in member ? (member.email ?? '') : '',
    role: member.role as TeamMember['role'],
    workspaceRole: member.role,
    workspaceRoleId: 'roleId' in member ? member.roleId ?? null : null,
    status: member.status as TeamMember['status'],
    memberType: member.memberType,
    createdAt: 'createdAt' in member ? new Date(member.createdAt) : new Date(),
  };
}

export default function TeamSettingsPage() {
  const { t } = useI18n();
  const st = useTranslations();
  const ts = t.settings.team;
  const { userId } = useAuth();
  const router = useRouter();
  const { can, isOwner, isLoading: permissionsLoading } = usePermissions();
  const queryClient = useQueryClient();
  const [currentPage, setCurrentPage] = React.useState(1);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [deletingMemberId, setDeletingMemberId] = React.useState<string | null>(null);
  const searchParams = useSearchParams();
  const initialMemberId = searchParams.get('member');
  const [selectedMemberId, setSelectedMemberId] = React.useState<string | null>(initialMemberId);
  const pageSize = 20;

  // Sync selection when the `?member=` query param changes (e.g. arriving via deep link)
  React.useEffect(() => {
    setSelectedMemberId(initialMemberId);
  }, [initialMemberId]);

  const canManageMembers = isOwner || can('team:update');
  const canReadMembers = isOwner || can('team:read');

  // Fetch active members for the main table. memberType: 'all' so external
  // guests are listed alongside internal employees (each row gets its own
  // "Guest" / role badge so they're easy to tell apart).
  const { data: membersResponse, isLoading: loading } = useTeamMembers(
    canReadMembers ? { limit: 100, status: 'ACTIVE', memberType: 'all' } : undefined
  );

  // Fetch pending invitations for the separate section
  const { data: pendingResponse } = usePendingMembers(canReadMembers && canManageMembers);

  // Sync from Clerk on mount (safety net against missed webhooks)
  const { mutate: syncFromClerk } = useSyncTeamFromClerk();
  React.useEffect(() => {
    if (canReadMembers) {
      syncFromClerk(undefined, {
        onSuccess: () => queryClient.invalidateQueries({ queryKey: teamKeys.all }),
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canReadMembers]);

  const removeMember = useRemoveMember();
  const resendInvite = useResendInvite();

  const allMembers = React.useMemo(
    () => (membersResponse?.data ?? []).map(toTeamMember),
    [membersResponse],
  );

  // Client-side pagination (core-api uses cursor pagination, TeamSection expects pages)
  const totalCount = membersResponse?.pagination?.totalCount ?? 0;
  const totalPages = Math.ceil(allMembers.length / pageSize) || 1;
  const paginatedUsers = React.useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return allMembers.slice(start, start + pageSize);
  }, [allMembers, currentPage, pageSize]);

  const deletingMember = deletingMemberId ? allMembers.find((u) => u.id === deletingMemberId) : null;
  const selectedMember = selectedMemberId ? allMembers.find((u) => u.id === selectedMemberId) ?? null : null;

  const refreshMembers = () => {
    queryClient.invalidateQueries({ queryKey: teamKeys.all });
  };

  const handleViewMember = (memberId: string) => {
    setSelectedMemberId(memberId);
  };

  const handleDeleteMember = () => {
    if (!deletingMemberId) return;

    removeMember.mutate(deletingMemberId, {
      onSuccess: () => {
        toast.success(ts.messages.removed);
        if (selectedMemberId === deletingMemberId) {
          setSelectedMemberId(null);
        }
        setDeletingMemberId(null);
      },
      onError: () => {
        toast.error(ts.messages.removeFailed);
        setDeletingMemberId(null);
      },
    });
  };

  const handleResendInvite = (memberId: string) => {
    resendInvite.mutate(memberId, {
      onSuccess: () => toast.success(ts.messages.inviteResent),
      onError: () => toast.error(ts.messages.inviteResendFailed),
    });
  };

  const handleCancelInvite = (memberId: string) => {
    removeMember.mutate(memberId, {
      onSuccess: () => toast.success(ts.messages.inviteCancelled),
      onError: () => toast.error(ts.messages.inviteCancelFailed),
    });
  };

  if (loading || permissionsLoading) {
    return <PageLoader fullScreen={false} />;
  }

  if (!canReadMembers) {
    return (
      <AccessDeniedEmptyState
        description={st('sweep.settings.teamPage.accessDeniedDescription')}
        permission="team:read"
        pageLabel={st('sweep.settings.teamPage.pageLabel')}
      />
    );
  }

  return (
    <>
      <TeamSection
        users={paginatedUsers}
        currentPage={currentPage}
        totalPages={totalPages}
        totalCount={totalCount}
        pageSize={pageSize}
        searchQuery={searchQuery}
        canManageMembers={canManageMembers}
        currentUserId={userId}
        onSearchChange={setSearchQuery}
        onPageChange={setCurrentPage}
        onViewMember={handleViewMember}
        onDeleteMember={setDeletingMemberId}
        onMemberInvited={refreshMembers}
      />

      {canManageMembers && (
        <PendingInvitationsSection
          members={pendingResponse?.data ?? []}
          onResendInvite={handleResendInvite}
          onCancelInvite={handleCancelInvite}
        />
      )}

      <MemberDetailPanel
        member={selectedMember}
        isOpen={!!selectedMember}
        onClose={() => {
          setSelectedMemberId(null);
          if (initialMemberId) router.replace('/settings/team');
        }}
        canManageMembers={canManageMembers}
        onRemoveMember={setDeletingMemberId}
        onMemberUpdated={refreshMembers}
        // Intentionally NOT passing onExpand — the panel toggles between
        // collapsed and expanded entirely via internal state, with the width
        // animating in place. No route navigation = no remount = no reload.
      />
      <ConfirmDialog
        open={!!deletingMemberId}
        onOpenChange={(open) => { if (!open) setDeletingMemberId(null); }}
        title={ts.removeTitle}
        description={ts.removeDescription.replace('{name}', deletingMember?.name || deletingMember?.email || 'this member')}
        confirmLabel={ts.removeButton}
        variant="destructive"
        onConfirm={handleDeleteMember}
      />
    </>
  );
}
