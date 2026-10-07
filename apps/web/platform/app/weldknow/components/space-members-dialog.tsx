/**
 * A teamspace's members: roles, adding teammates, removing, leaving.
 *
 * Owners (and admins holding knowledge:manage) change membership; everyone
 * else sees who is in it, so they know whom to ask. The API answers 409 when
 * a change would leave the teamspace without an owner.
 */

import { useMemo, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { Loader2, LogOut, UserPlus, X } from 'lucide-react';
import { toast } from 'sonner';
import { isApiError } from '@weldsuite/api-client';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { getTranslations } from '@/lib/i18n';
import {
  useAddKnowledgeSpaceMember,
  useKnowledgeSpaceMembers,
  useKnowledgeTeammates,
  useLeaveKnowledgeSpace,
  useRemoveKnowledgeSpaceMember,
  useUpdateKnowledgeSpaceMember,
  type KnowledgeSpace,
  type KnowledgeSpaceMember,
  type KnowledgeSpaceRole,
} from '@/hooks/queries/use-knowledge-queries';

const ROLES: KnowledgeSpaceRole[] = ['owner', 'editor', 'viewer'];

function memberLabel(member: { name?: string | null; email?: string | null; userId: string }): string {
  return member.name || member.email || member.userId;
}

export function useRoleLabel() {
  const t = getTranslations('weldknow');
  return (role: KnowledgeSpaceRole) =>
    role === 'owner' ? t.members.roleOwner : role === 'editor' ? t.members.roleEditor : t.members.roleViewer;
}

function RoleSelect({
  value,
  onChange,
  disabled,
}: Readonly<{ value: KnowledgeSpaceRole; onChange: (role: KnowledgeSpaceRole) => void; disabled?: boolean }>) {
  const roleLabel = useRoleLabel();
  return (
    <Select value={value} onValueChange={(next) => onChange(next as KnowledgeSpaceRole)} disabled={disabled}>
      <SelectTrigger className="h-8 w-28">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ROLES.map((role) => (
          <SelectItem key={role} value={role}>
            {roleLabel(role)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

interface SpaceMembersDialogProps {
  space: KnowledgeSpace | null;
  onOpenChange: (open: boolean) => void;
}

export function SpaceMembersDialog({ space, onOpenChange }: Readonly<SpaceMembersDialogProps>) {
  const t = getTranslations('weldknow');
  const roleLabel = useRoleLabel();
  const { userId: currentUserId } = useAuth();
  const open = space !== null;
  const canManage = space?.canManage ?? false;

  const { data: membersData, isLoading } = useKnowledgeSpaceMembers(space?.id ?? null, open);
  const { data: teammatesData } = useKnowledgeTeammates(open && canManage);
  const addMember = useAddKnowledgeSpaceMember();
  const updateMember = useUpdateKnowledgeSpaceMember();
  const removeMember = useRemoveKnowledgeSpaceMember();
  const leaveSpace = useLeaveKnowledgeSpace();

  const [newUserId, setNewUserId] = useState('');
  const [newRole, setNewRole] = useState<KnowledgeSpaceRole>('editor');
  const [removing, setRemoving] = useState<KnowledgeSpaceMember | null>(null);

  const members = useMemo(() => membersData?.data ?? [], [membersData]);
  const candidates = useMemo(() => {
    const present = new Set(members.map((m) => m.userId));
    return (teammatesData?.data ?? []).filter((teammate) => !present.has(teammate.userId));
  }, [members, teammatesData]);

  /** 409 means the change would leave the teamspace without an owner. */
  const failed = (err: unknown, fallback: string) =>
    toast.error(isApiError(err) && err.status === 409 ? t.members.lastOwner : fallback);

  if (!space) return null;
  const leaving = removing?.userId === currentUserId;

  async function add() {
    if (!space || !newUserId) return;
    try {
      await addMember.mutateAsync({ spaceId: space.id, userId: newUserId, role: newRole });
      setNewUserId('');
      toast.success(t.members.addSuccess);
    } catch (err) {
      failed(err, t.members.addError);
    }
  }

  async function changeRole(member: KnowledgeSpaceMember, role: KnowledgeSpaceRole) {
    if (!space || role === member.role) return;
    try {
      await updateMember.mutateAsync({ spaceId: space.id, userId: member.userId, role });
    } catch (err) {
      failed(err, t.members.updateError);
    }
  }

  async function remove(member: KnowledgeSpaceMember) {
    if (!space) return;
    try {
      if (member.userId === currentUserId) {
        await leaveSpace.mutateAsync(space.id);
        toast.success(t.teamspaces.leaveSuccess);
        onOpenChange(false);
      } else {
        await removeMember.mutateAsync({ spaceId: space.id, userId: member.userId });
        toast.success(t.members.removeSuccess);
      }
    } catch (err) {
      failed(err, member.userId === currentUserId ? t.teamspaces.leaveError : t.members.removeError);
    } finally {
      setRemoving(null);
    }
  }

  const self = members.find((m) => m.userId === currentUserId);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {t.members.title} · {space.name}
            </DialogTitle>
            <DialogDescription>{t.members.description}</DialogDescription>
          </DialogHeader>

          {canManage && (
            <div className="space-y-2 rounded-md border bg-muted/30 p-3">
              <p className="text-xs font-medium">{t.members.addLabel}</p>
              {candidates.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t.members.everyoneAdded}</p>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Select value={newUserId} onValueChange={setNewUserId}>
                    <SelectTrigger className="h-8 min-w-48 flex-1">
                      <SelectValue placeholder={t.members.addPlaceholder} />
                    </SelectTrigger>
                    <SelectContent>
                      {candidates.map((teammate) => (
                        <SelectItem key={teammate.userId} value={teammate.userId}>
                          {memberLabel(teammate)}
                          {teammate.name && teammate.email ? ` · ${teammate.email}` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <RoleSelect value={newRole} onChange={setNewRole} />
                  <Button type="button" size="sm" onClick={() => void add()} disabled={!newUserId || addMember.isPending}>
                    {addMember.isPending ? (
                      <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                    ) : (
                      <UserPlus className="mr-1.5 h-4 w-4" />
                    )}
                    {t.members.add}
                  </Button>
                </div>
              )}
            </div>
          )}

          {isLoading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : members.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">{t.members.empty}</p>
          ) : (
            <ul className="max-h-80 divide-y overflow-y-auto rounded-md border">
              {members.map((member) => {
                const name = memberLabel(member);
                const isSelf = member.userId === currentUserId;
                return (
                  <li key={member.userId} className="flex items-center gap-3 px-3 py-2">
                    <Avatar className="h-8 w-8">
                      {member.picture && <AvatarImage src={member.picture} alt="" />}
                      <AvatarFallback className="text-xs">{name.slice(0, 2).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {name}
                        {isSelf && <span className="ml-1.5 text-xs font-normal text-muted-foreground">{t.members.you}</span>}
                      </p>
                      {member.name && member.email && (
                        <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                      )}
                    </div>
                    {canManage ? (
                      <RoleSelect
                        value={member.role}
                        disabled={updateMember.isPending}
                        onChange={(role) => void changeRole(member, role)}
                      />
                    ) : (
                      <Badge variant="secondary">{roleLabel(member.role)}</Badge>
                    )}
                    {canManage && !isSelf && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setRemoving(member)}
                        aria-label={t.members.remove}
                        title={t.members.remove}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <div className="flex items-center justify-between">
            {self ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setRemoving(self)}>
                <LogOut className="mr-1.5 h-4 w-4" />
                {t.sidebar.leave}
              </Button>
            ) : (
              <span />
            )}
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {t.members.close}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(next) => !next && setRemoving(null)}
        title={leaving ? t.teamspaces.leaveTitle : t.members.remove}
        description={leaving ? t.teamspaces.leaveDescription : removing ? memberLabel(removing) : ''}
        confirmLabel={leaving ? t.sidebar.leave : t.members.remove}
        cancelLabel={t.common.cancel}
        variant="destructive"
        loading={removeMember.isPending || leaveSpace.isPending}
        onConfirm={() => (removing ? remove(removing) : undefined)}
      />
    </>
  );
}
