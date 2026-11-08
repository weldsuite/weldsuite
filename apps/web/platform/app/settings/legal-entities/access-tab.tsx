/**
 * Access tab (`legal_entities:manage`): the Restricted switch and the members
 * with their role inside this entity. See "Per-entity access" in
 * docs/plans/legal-entities.md.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';
import type { LegalEntity, LegalEntityAccessMember } from '@weldsuite/app-api-client/schemas/legal-entities';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { ErrorBanner, ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { Label } from '@weldsuite/ui/components/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  useLegalEntityAccess,
  useRemoveLegalEntityMember,
  useSetLegalEntityMember,
  useSetLegalEntityRestricted,
} from '@/hooks/queries/use-legal-entities-queries';
import { useWorkspaceMemberDirectory, useWorkspaceRoles } from '@/hooks/queries/use-settings-queries';
import { useI18n } from '@/lib/i18n/provider';
import { assignableEntityRoles, availableMembersToAdd, filterMembersByQuery } from './access-members';

/** Select value for "their workspace role" (a null role id on the API). */
const WORKSPACE_ROLE = '__workspace__';

function initials(name: string | null, email: string | null): string {
  const source = (name || email || '?').trim();
  return source.slice(0, 2).toUpperCase();
}

interface AccessTabProps {
  entity: LegalEntity;
}

export function AccessTab({ entity }: Readonly<AccessTabProps>) {
  const { t } = useI18n();
  const ta = t.settings.legalEntities.access;
  const { data: access, isLoading, error, refetch } = useLegalEntityAccess(entity.id);
  const { data: rolesResponse, isLoading: rolesLoading } = useWorkspaceRoles();
  const setRestricted = useSetLegalEntityRestricted(entity.id);
  const setMember = useSetLegalEntityMember(entity.id);
  const removeMember = useRemoveLegalEntityMember(entity.id);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<LegalEntityAccessMember | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const roles = useMemo(() => assignableEntityRoles(rolesResponse?.data ?? []), [rolesResponse]);

  async function toggleRestricted(restricted: boolean) {
    try {
      await setRestricted.mutateAsync(restricted);
      setActionError(null);
      toast.success(ta.restrictedUpdated);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : ta.failed);
    }
  }

  async function changeRole(member: LegalEntityAccessMember, value: string) {
    try {
      await setMember.mutateAsync({ userId: member.userId, roleId: value === WORKSPACE_ROLE ? null : value });
      setActionError(null);
      toast.success(ta.roleUpdated);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : ta.failed);
    }
  }

  async function confirmRemove() {
    if (!removing) return;
    try {
      await removeMember.mutateAsync(removing.userId);
      toast.success(ta.removed);
      setActionError(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : ta.failed);
    } finally {
      setRemoving(null);
    }
  }

  if (isLoading) return <PageLoader fullScreen={false} className="min-h-[200px] pb-0" />;
  if (error || !access) return <ErrorState message={ta.loadFailed} onRetry={() => refetch()} />;

  let membersBody: ReactNode;
  if (access.members.length === 0) {
    membersBody = <EmptyText>{ta.noMembers}</EmptyText>;
  } else {
    membersBody = (
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{ta.member}</TableHead>
              <TableHead>{ta.workspaceRole}</TableHead>
              <TableHead className="min-w-[200px]">{ta.entityRole}</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {access.members.map((member) => {
              const known = member.roleId === null || roles.some((role) => role.id === member.roleId);
              return (
                <TableRow key={member.userId}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Avatar className="h-8 w-8">
                        {member.picture && <AvatarImage src={member.picture} alt="" />}
                        <AvatarFallback>{initials(member.name, member.email)}</AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{member.name ?? member.email}</p>
                        {member.name && member.email && (
                          <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">{member.workspaceRoleName ?? member.workspaceRole}</TableCell>
                  <TableCell>
                    <Select
                      value={member.roleId ?? WORKSPACE_ROLE}
                      onValueChange={(value) => changeRole(member, value)}
                      disabled={setMember.isPending}
                    >
                      <SelectTrigger aria-label={ta.entityRole}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={WORKSPACE_ROLE}>{ta.workspaceRoleOption}</SelectItem>
                        {roles.map((role) => (
                          <SelectItem key={role.id} value={role.id}>
                            {role.name}
                          </SelectItem>
                        ))}
                        {!known && member.roleId && (
                          <SelectItem value={member.roleId}>{member.roleName ?? member.roleId}</SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={ta.remove}
                      onClick={() => setRemoving(member)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-6">
      <ErrorBanner error={actionError} onDismiss={() => setActionError(null)} />
      <SectionCard title={ta.title} description={ta.description}>
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-6">
            <div className="space-y-1">
              <Label htmlFor="legal-entity-restricted" className="text-sm font-medium">
                {ta.restricted}
              </Label>
              <p className="text-sm text-muted-foreground">
                {access.restricted ? ta.restrictedOnHint : ta.restrictedOffHint}
              </p>
            </div>
            <Switch
              id="legal-entity-restricted"
              checked={access.restricted}
              onCheckedChange={toggleRestricted}
              disabled={setRestricted.isPending}
            />
          </div>
          <InfoBanner variant="info">{ta.explanation}</InfoBanner>
        </div>
      </SectionCard>

      <SectionCard
        title={ta.members}
        action={
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="mr-2 h-4 w-4" />
            {ta.add}
          </Button>
        }
      >
        {membersBody}
      </SectionCard>

      <AddMemberDialog
        entityId={entity.id}
        open={adding}
        onOpenChange={setAdding}
        listed={access.members}
        roles={roles}
        rolesLoading={rolesLoading}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={ta.removeTitle}
        description={ta.removeDescription}
        confirmLabel={ta.remove}
        variant="destructive"
        onConfirm={confirmRemove}
      />
    </div>
  );
}

interface AddMemberDialogProps {
  entityId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  listed: LegalEntityAccessMember[];
  roles: Array<{ id: string; name: string }>;
  rolesLoading: boolean;
}

function AddMemberDialog({ entityId, open, onOpenChange, listed, roles, rolesLoading }: Readonly<AddMemberDialogProps>) {
  const { t } = useI18n();
  const ta = t.settings.legalEntities.access;
  const { data: directory, isLoading } = useWorkspaceMemberDirectory(open);
  const setMember = useSetLegalEntityMember(entityId);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [roleId, setRoleId] = useState(WORKSPACE_ROLE);
  const [error, setError] = useState<string | null>(null);

  const candidates = useMemo(
    () => filterMembersByQuery(availableMembersToAdd(directory?.data ?? [], listed), query),
    [directory, listed, query],
  );

  function handleOpenChange(next: boolean) {
    if (!next) {
      setQuery('');
      setSelected(null);
      setRoleId(WORKSPACE_ROLE);
      setError(null);
    }
    onOpenChange(next);
  }

  async function submit() {
    if (!selected) return;
    try {
      await setMember.mutateAsync({ userId: selected, roleId: roleId === WORKSPACE_ROLE ? null : roleId });
      toast.success(ta.added);
      handleOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : ta.failed);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{ta.addTitle}</DialogTitle>
          <DialogDescription>{ta.addDescription}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <ErrorBanner error={error} onDismiss={() => setError(null)} />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={ta.searchMembers}
            aria-label={ta.searchMembers}
          />
          <div className="max-h-64 overflow-y-auto rounded-md border" role="listbox" aria-label={ta.member}>
            {isLoading ? (
              <PageLoader fullScreen={false} className="min-h-[80px] pb-0" />
            ) : candidates.length === 0 ? (
              <EmptyText>{ta.noMembersToAdd}</EmptyText>
            ) : (
              candidates.map((member) => (
                <button
                  key={member.userId}
                  type="button"
                  role="option"
                  aria-selected={selected === member.userId}
                  onClick={() => setSelected(member.userId)}
                  className={`flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent ${
                    selected === member.userId ? 'bg-accent' : ''
                  }`}
                >
                  <Avatar className="h-8 w-8">
                    {member.picture && <AvatarImage src={member.picture} alt="" />}
                    <AvatarFallback>{initials(member.name ?? null, member.email ?? null)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{member.name ?? member.email}</p>
                    {member.name && member.email && (
                      <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                    )}
                  </div>
                </button>
              ))
            )}
          </div>
          <div className="space-y-2">
            <Label>{ta.entityRole}</Label>
            <Select value={roleId} onValueChange={setRoleId} disabled={rolesLoading}>
              <SelectTrigger>
                <SelectValue placeholder={rolesLoading ? ta.rolesLoading : undefined} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={WORKSPACE_ROLE}>{ta.workspaceRoleOption}</SelectItem>
                {roles.map((role) => (
                  <SelectItem key={role.id} value={role.id}>
                    {role.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            {t.common.actions.cancel}
          </Button>
          <Button type="button" onClick={submit} disabled={!selected || setMember.isPending}>
            {ta.add}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
