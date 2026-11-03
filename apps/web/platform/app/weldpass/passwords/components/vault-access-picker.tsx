/**
 * "Who has access" in the New vault dialog: teammates and their role, picked
 * before the vault exists and sent with the create request. Later changes go
 * through the vault's members panel.
 */

import { useMemo, useState } from 'react';
import { UserPlus, X } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import type { WeldPassVaultRole } from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { useWeldPassTeammates } from '@/hooks/queries/use-weldpass-passwords-queries';
import { usePasswordsT } from '../lib/use-passwords-t';
import { RoleSelect, VAULT_ROLES, memberLabel } from './vault-members-panel';

export interface InitialVaultMember {
  userId: string;
  role: WeldPassVaultRole;
}

export function VaultAccessPicker({
  value,
  onChange,
  currentUserId,
  disabled,
}: Readonly<{
  value: InitialVaultMember[];
  onChange: (members: InitialVaultMember[]) => void;
  /** The creator: always the first manager, so never offered. */
  currentUserId: string | undefined;
  disabled?: boolean;
}>) {
  const tp = usePasswordsT();
  const { data: teammates } = useWeldPassTeammates();
  const [newUserId, setNewUserId] = useState('');
  const [newRole, setNewRole] = useState<WeldPassVaultRole>('viewer');

  const byId = useMemo(
    () => new Map((teammates ?? []).map((teammate) => [teammate.userId, teammate])),
    [teammates],
  );
  const candidates = useMemo(() => {
    const chosen = new Set(value.map((member) => member.userId));
    return (teammates ?? []).filter(
      (teammate) => teammate.userId !== currentUserId && !chosen.has(teammate.userId),
    );
  }, [teammates, value, currentUserId]);

  function add() {
    if (!newUserId) return;
    onChange([...value, { userId: newUserId, role: newRole }]);
    setNewUserId('');
    setNewRole('viewer');
  }

  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="text-sm font-medium">{tp('vaultForm.accessTitle')}</legend>

      <ul className="divide-y rounded-md border">
        <li className="flex items-center gap-3 px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-sm">{tp('vaultForm.accessYou')}</span>
          <Badge variant="secondary">{tp('roles.manager')}</Badge>
        </li>
        {value.map((member) => {
          const teammate = byId.get(member.userId);
          const name = teammate ? memberLabel(teammate) : member.userId;
          return (
            <li key={member.userId} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{name}</p>
                {teammate?.name && teammate.email && (
                  <p className="truncate text-xs text-muted-foreground">{teammate.email}</p>
                )}
              </div>
              <RoleSelect
                value={member.role}
                label={tp('members.roleFor', { name })}
                disabled={disabled}
                onChange={(role) =>
                  onChange(
                    value.map((other) =>
                      other.userId === member.userId ? { ...other, role } : other,
                    ),
                  )
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onChange(value.filter((other) => other.userId !== member.userId))}
                aria-label={tp('members.remove', { name })}
                title={tp('members.remove', { name })}
              >
                <X className="h-4 w-4" />
              </Button>
            </li>
          );
        })}
      </ul>

      {value.length === 0 && (
        <p className="text-xs text-muted-foreground">{tp('vaultForm.accessOnlyYou')}</p>
      )}

      {candidates.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={newUserId} onValueChange={setNewUserId}>
            <SelectTrigger className="min-w-40 flex-1" aria-label={tp('members.pickTeammate')}>
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
          <Button type="button" size="sm" variant="outline" onClick={add} disabled={!newUserId}>
            <UserPlus className="mr-1.5 h-4 w-4" />
            {tp('members.add')}
          </Button>
        </div>
      )}

      {value.length > 0 && (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {VAULT_ROLES.map((role) => (
            <li key={role}>
              <span className="font-medium text-foreground">{tp(`roles.${role}`)}</span>
              {' — '}
              {tp(`roles.${role}Hint`)}
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
