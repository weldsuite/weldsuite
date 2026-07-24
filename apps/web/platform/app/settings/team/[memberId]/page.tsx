import * as React from 'react';
import { usePermissions } from '@weldsuite/permissions/react';
import { useParams, useRouter } from '@/lib/router';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { PageLoader } from '@/components/page-loader';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { MemberDetailPanel } from '@/components/settings/member-detail-panel';
import { AccessDeniedEmptyState } from '@/components/access-denied-empty-state';
import type { TeamMember } from '@/components/settings';
import { useTeamMember, teamKeys } from '@/hooks/queries/use-team-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import type { Member } from '@weldsuite/core-api-client/schemas/members';

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
    createdAt: 'createdAt' in member ? new Date(member.createdAt) : new Date(),
  };
}

export default function MemberDetailPage() {
  const { t } = useI18n();
  const st = useTranslations();
  const ts = t.settings.team;
  const router = useRouter();
  const params = useParams();
  const memberId = (params as { memberId?: string }).memberId ?? '';
  const { can, isOwner, isLoading: permissionsLoading } = usePermissions();
  const queryClient = useQueryClient();
  const { getClient } = useAppApiClient();

  const canManageMembers = isOwner || can('team:update');
  const canReadMembers = isOwner || can('team:read');

  const { data: memberResponse, isLoading: memberLoading } = useTeamMember(
    canReadMembers ? memberId : '',
  );
  const member = memberResponse?.data ? toTeamMember(memberResponse.data) : null;

  const [deletingMemberId, setDeletingMemberId] = React.useState<string | null>(null);

  const refreshMembers = () => {
    queryClient.invalidateQueries({ queryKey: teamKeys.all });
  };

  const handleClose = () => {
    router.push('/settings/team');
  };

  const handleDeleteMember = async () => {
    if (!deletingMemberId) return;
    try {
      const client = await getClient();
      // app-api DELETE /api/team-members/:id (was api-worker
      // /settings/members/:id). Replies 204; failures throw.
      await client.delete<void>(`/team-members/${deletingMemberId}`);
      toast.success(ts.messages.removed);
      refreshMembers();
      router.push('/settings/team');
    } catch (error) {
      console.error('Failed to delete member:', error);
      toast.error(ts.messages.removeFailed);
    } finally {
      setDeletingMemberId(null);
    }
  };

  if (permissionsLoading || memberLoading) {
    return <PageLoader fullScreen={false} />;
  }

  if (!canReadMembers) {
    return (
      <AccessDeniedEmptyState
        description={st('sweep.settings.memberDetail.accessDeniedDescription')}
        permission="team:read"
        pageLabel={st('sweep.settings.memberDetail.pageLabel')}
      />
    );
  }

  if (!member) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
        <p className="text-lg font-medium">{st('sweep.settings.memberDetail.notFound')}</p>
        <p className="text-sm mt-1">{st('sweep.settings.memberDetail.notFoundHint')}</p>
      </div>
    );
  }

  return (
    <>
      <MemberDetailPanel
        member={member}
        isOpen
        onClose={handleClose}
        canManageMembers={canManageMembers}
        onRemoveMember={setDeletingMemberId}
        onMemberUpdated={refreshMembers}
        defaultExpanded
        skipAnimation
        // Intentionally NOT passing onCollapse — minimize toggles internal
        // state in place rather than navigating, so the user doesn't get a
        // route reload. The URL stays at /settings/team/{memberId} even
        // when the panel is collapsed; that's a small UX trade-off for
        // a smooth, mount-stable animation.
      />
      <ConfirmDialog
        open={!!deletingMemberId}
        onOpenChange={(open) => { if (!open) setDeletingMemberId(null); }}
        title={ts.removeTitle}
        description={ts.removeDescription.replace('{name}', member.name || member.email || st('sweep.settings.memberDetail.thisMember'))}
        confirmLabel={ts.removeButton}
        variant="destructive"
        onConfirm={handleDeleteMember}
      />
    </>
  );
}
