/**
 * A shared vault's members: roles, adding teammates, removing, leaving.
 *
 * The API answers 409 with a plain-language message when a change would leave
 * the vault without a manager; it is shown as it arrives.
 */

import { useMemo, useState } from 'react';
import { LogOut, Loader2, UserPlus, X } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import type {
  WeldPassVault,
  WeldPassVaultMember,
  WeldPassVaultRole,
} from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  useAddWeldPassVaultMember,
  useRemoveWeldPassVaultMember,
  useUpdateWeldPassVaultMember,
  useWeldPassTeammates,
  useWeldPassVaultMembers,
} from '@/hooks/queries/use-weldpass-passwords-queries';
import { ErrorBanner, InlineSpinner, errorMessage } from '../../components/shared';
import { usePasswordsT } from '../lib/use-passwords-t';

export const VAULT_ROLES: WeldPassVaultRole[] = ['viewer', 'editor', 'manager'];

export function memberLabel(member: {
  name?: string | null;
  email?: string | null;
  userId: string;
}): string {
  return member.name || member.email || member.userId;
}

function RoleSelect({
  value,
  onChange,
  disabled,
  label,
}: Readonly<{
  value: WeldPassVaultRole;
  onChange: (role: WeldPassVaultRole) => void;
  disabled?: boolean;
  label: string;
}>) {
  const tp = usePasswordsT();
  return (
    <Select value={value} onValueChange={(next) => onChange(next as WeldPassVaultRole)} disabled={disabled}>
      <SelectTrigger className="w-32" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {VAULT_ROLES.map((role) => (
          <SelectItem key={role} value={role}>
            {tp(`roles.${role}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function VaultMembersPanel({
  vault,
  canAdminister,
  currentUserId,
  onLeft,
}: Readonly<{
  vault: WeldPassVault;
  /** Manager of the vault or a workspace admin: may add, change and remove. */
  canAdminister: boolean;
  currentUserId: string | undefined;
  onLeft: () => void;
}>) {
  const tp = usePasswordsT();
  const { data: members, isLoading, error } = useWeldPassVaultMembers(vault.id);
  const { data: teammates } = useWeldPassTeammates(canAdminister);
  const addMember = useAddWeldPassVaultMember(vault.id);
  const updateMember = useUpdateWeldPassVaultMember(vault.id);
  const removeMember = useRemoveWeldPassVaultMember(vault.id);

  const [newUserId, setNewUserId] = useState('');
  const [newRole, setNewRole] = useState<WeldPassVaultRole>('viewer');
  const [failure, setFailure] = useState<string | null>(null);
  const [removing, setRemoving] = useState<WeldPassVaultMember | null>(null);

  const candidates = useMemo(() => {
    const present = new Set((members ?? []).map((member) => member.userId));
    return (teammates ?? []).filter((teammate) => !present.has(teammate.userId));
  }, [members, teammates]);

  const isMember = Boolean(members?.some((member) => member.userId === currentUserId));

  async function add() {
    if (!newUserId) return;
    setFailure(null);
    try {
      await addMember.mutateAsync({ userId: newUserId, role: newRole });
      setNewUserId('');
      setNewRole('viewer');
    } catch (err) {
      setFailure(errorMessage(err, tp('members.addFailed')));
    }
  }

  async function changeRole(member: WeldPassVaultMember, role: WeldPassVaultRole) {
    if (role === member.role) return;
    setFailure(null);
    try {
      await updateMember.mutateAsync({ userId: member.userId, role });
    } catch (err) {
      setFailure(errorMessage(err, tp('members.roleFailed')));
    }
  }

  async function remove(member: WeldPassVaultMember) {
    setFailure(null);
    try {
      await removeMember.mutateAsync(member.userId);
      setRemoving(null);
      if (member.userId === currentUserId) onLeft();
    } catch (err) {
      setRemoving(null);
      // Includes the 409 "a vault needs at least one manager" message.
      setFailure(errorMessage(err, tp('members.removeFailed')));
    }
  }

  const leaving = removing?.userId === currentUserId;

  return (
    <div className="space-y-4">
      <ErrorBanner
        error={failure ?? (error ? errorMessage(error, tp('members.loadFailed')) : null)}
        onDismiss={() => setFailure(null)}
      />

      {vault.role === null && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
          {tp('members.notAMember')}
        </p>
      )}

      {isLoading ? (
        <InlineSpinner />
      ) : (
        <ul className="divide-y rounded-md border">
          {members?.map((member) => {
            const name = memberLabel(member);
            const isSelf = member.userId === currentUserId;
            return (
              <li key={member.userId} className="flex items-center gap-3 px-3 py-2">
                <Avatar className="h-8 w-8">
                  {member.picture && <AvatarImage src={member.picture} alt="" />}
                  <AvatarFallback className="text-xs">
                    {name.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {name}
                    {isSelf && (
                      <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                        {tp('members.you')}
                      </span>
                    )}
                  </p>
                  {member.name && member.email && (
                    <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                  )}
                </div>

                {canAdminister ? (
                  <RoleSelect
                    value={member.role}
                    label={tp('members.roleFor', { name })}
                    disabled={updateMember.isPending}
                    onChange={(role) => void changeRole(member, role)}
                  />
                ) : (
                  <Badge variant="secondary">{tp(`roles.${member.role}`)}</Badge>
                )}

                {canAdminister && !isSelf && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setRemoving(member)}
                    aria-label={tp('members.remove', { name })}
                    title={tp('members.remove', { name })}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canAdminister && (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3">
          <p className="text-xs font-medium">{tp('members.addTitle')}</p>
          {candidates.length === 0 ? (
            <p className="text-xs text-muted-foreground">{tp('members.nobodyToAdd')}</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Select value={newUserId} onValueChange={setNewUserId}>
                <SelectTrigger className="min-w-48 flex-1" aria-label={tp('members.pickTeammate')}>
                  <SelectValue placeholder={tp('members.pickTeammate')} />
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
              <RoleSelect value={newRole} onChange={setNewRole} label={tp('members.newRole')} />
              <Button
                type="button"
                size="sm"
                onClick={() => void add()}
                disabled={!newUserId || addMember.isPending}
              >
                {addMember.isPending ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <UserPlus className="mr-1.5 h-4 w-4" />
                )}
                {tp('members.add')}
              </Button>
            </div>
          )}
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {VAULT_ROLES.map((role) => (
              <li key={role}>
                <span className="font-medium text-foreground">{tp(`roles.${role}`)}</span>
                {' — '}
                {tp(`roles.${role}Hint`)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {isMember && (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              const self = members?.find((member) => member.userId === currentUserId);
              if (self) setRemoving(self);
            }}
          >
            <LogOut className="mr-1.5 h-4 w-4" />
            {tp('members.leave')}
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={
          leaving
            ? tp('members.leaveTitle', { vault: vault.name })
            : tp('members.removeTitle', { name: removing ? memberLabel(removing) : '' })
        }
        description={leaving ? tp('members.leaveDescription') : tp('members.removeDescription')}
        confirmLabel={leaving ? tp('members.leave') : tp('members.removeConfirm')}
        cancelLabel={tp('common.cancel')}
        variant="destructive"
        onConfirm={() => (removing ? remove(removing) : undefined)}
      />
    </div>
  );
}
