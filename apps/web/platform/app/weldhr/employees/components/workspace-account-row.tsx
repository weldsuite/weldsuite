/**
 * "Workspace account" row of the employee panel's Details tab.
 *
 * New employees are created from a workspace member or together with their
 * invitation, so an unlinked employee is either still to accept (hr-api links
 * them by email once they do) or from before every employee had to be a
 * member. For the latter: link them to an existing member, or invite them (as
 * an Employee member by default, which gives them My HR and WeldChat only).
 *
 * Same geometry as the panel's other property rows: a linked member opens
 * their team-member panel (in place, with a back arrow); "Not linked" opens a
 * menu with the link and invite actions.
 */

import { useMemo, useState, type ComponentType } from 'react';
import { toast } from 'sonner';
import { Link2, Loader2, Send, UserPlus } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrEmployeeDetail } from '@weldsuite/app-api-client/domains/weldhr';
import { useObjectPanel } from '@/components/object-panel';
import { useAppApi } from '@/lib/api/use-app-api';
import { useMemberProfile, useTeamMembers } from '@/hooks/queries/use-team-queries';
import { useWorkspaceRoles } from '@/hooks/queries/use-settings-queries';
import { useHrAvailableMembers, useUpdateHrEmployee } from '@/hooks/queries/use-weldhr-queries';
import { errorMessage } from '../../components/shared';
import { ErrorBanner } from '@weldsuite/ui/components/error-banner';

type InviteAs = 'EMPLOYEE' | 'INTERNAL';

function memberEmail(member: { email?: string | null } | object): string | null {
  return 'email' in member && typeof member.email === 'string' ? member.email : null;
}

function pickDefaultRoleId(roles: Array<{ id: string; name: string }> | undefined): string {
  if (!roles?.length) return '';
  const member = roles.find((r) => r.name.toUpperCase() === 'MEMBER');
  const viewer = roles.find((r) => r.name.toUpperCase() === 'VIEWER');
  return (member ?? viewer ?? roles[0])!.id;
}

/** Whether an invitation for this employee's email is still waiting: they are linked on acceptance. */
function usePendingInvite(employee: HrEmployeeDetail, enabled: boolean) {
  const { data, refetch } = useTeamMembers(
    enabled ? { limit: 10, status: 'PENDING', memberType: 'all', search: employee.email } : undefined,
  );
  const pendingInvite = useMemo(() => {
    const email = employee.email.trim().toLowerCase();
    return (data?.data ?? []).some((m) => (memberEmail(m) ?? '').toLowerCase() === email);
  }, [data, employee.email]);
  return { pendingInvite, refetchPending: refetch };
}

// The value box of `PropertyRow`, so this row's hover border sits where the
// editable rows' does.
const VALUE_BOX =
  'text-sm min-w-0 flex items-center min-h-[32px] py-1 rounded-[9px] -mx-2 px-[7px] box-border border border-transparent text-left';

function LinkedMember({ userId, fallbackName }: Readonly<{ userId: string; fallbackName: string }>) {
  const { data: profile } = useMemberProfile(userId);
  const { open: openPanel } = useObjectPanel();
  // The member's name, else the employee's own (the account is theirs): never the raw user id.
  const name = profile?.name || profile?.email || fallbackName;
  return (
    <button
      type="button"
      className={`${VALUE_BOX} cursor-pointer gap-2 transition-colors hover:border-border`}
      onClick={() => openPanel({ type: 'team-member', id: userId, stack: true })}
    >
      <Avatar className="size-[18px] flex-shrink-0">
        {profile?.picture && <AvatarImage src={profile.picture} alt={name} className="object-cover" />}
        <AvatarFallback className="text-[9px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
          {(name.trim()[0] ?? '?').toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <span className="truncate text-foreground">{name}</span>
    </button>
  );
}

export function EmployeeWorkspaceAccountRow({
  employee,
  icon: Icon,
}: Readonly<{ employee: HrEmployeeDetail; icon: ComponentType<{ className?: string }> }>) {
  const t = useTranslations();
  const { can } = usePermissions();
  const { teamMembers } = useAppApi();
  const updateEmployee = useUpdateHrEmployee();
  const canReadTeam = can('team:read');
  const canInvite = can('team:create');
  // PATCH /employees/:id (the link) and the available-members list both need employees:update.
  const canLink = can('employees:update');

  const { pendingInvite, refetchPending } = usePendingInvite(employee, canReadTeam && !employee.userId);
  // Members who are free to link: active INTERNAL / EMPLOYEE, not an employee yet.
  const { data: availableMembers } = useHrAvailableMembers({ limit: 200 }, { enabled: canLink && !employee.userId });
  const { data: rolesResponse } = useWorkspaceRoles(canInvite);
  const roles = rolesResponse?.data ?? [];

  const [dialog, setDialog] = useState<'invite' | 'link' | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string>('');
  const [inviteAs, setInviteAs] = useState<InviteAs>('EMPLOYEE');
  const [roleId, setRoleId] = useState<string>('');
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const linkableMembers = useMemo(() => availableMembers ?? [], [availableMembers]);

  const emailMatch = useMemo(() => {
    const email = employee.email.trim().toLowerCase();
    return linkableMembers.find((m) => (m.email ?? '').toLowerCase() === email) ?? null;
  }, [linkableMembers, employee.email]);

  function openInvite() {
    setFailure(null);
    setInviteAs('EMPLOYEE');
    setRoleId(pickDefaultRoleId(roles));
    setDialog('invite');
  }

  function openLink() {
    setFailure(null);
    setSelectedUserId(emailMatch?.userId ?? '');
    setDialog('link');
  }

  async function inviteMember() {
    setPending(true);
    setFailure(null);
    try {
      await teamMembers.inviteMember({
        email: employee.email,
        name: employee.displayName,
        // An Employee member's access is fixed; the server ignores a role for them.
        roleId: inviteAs === 'INTERNAL' ? roleId || null : null,
        memberType: inviteAs,
      });
      toast.success(t('weldhr.employees.workspace.inviteSent'));
      setDialog(null);
      if (canReadTeam) void refetchPending();
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.employees.workspace.inviteFailed')));
    } finally {
      setPending(false);
    }
  }

  async function linkMember() {
    if (!selectedUserId) {
      setFailure(t('weldhr.employees.workspace.linkRequired'));
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      await updateEmployee.mutateAsync({ id: employee.id, userId: selectedUserId });
      toast.success(t('weldhr.employees.workspace.linkSuccess'));
      setDialog(null);
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.employees.workspace.linkFailed')));
    } finally {
      setPending(false);
    }
  }

  let value;
  if (employee.userId) {
    value = <LinkedMember userId={employee.userId} fallbackName={employee.displayName || employee.email} />;
  } else if (pendingInvite) {
    value = (
      <span className={`${VALUE_BOX} text-muted-foreground`} title={t('weldhr.employees.workspace.invitePending', { email: employee.email })}>
        {t('weldhr.employees.workspace.invitePendingShort')}
      </span>
    );
  } else if (canLink || canInvite) {
    value = (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={`${VALUE_BOX} cursor-pointer transition-colors hover:border-border data-[state=open]:border-border`}
            title={t('weldhr.employees.workspace.notLinked')}
          >
            <span className="text-muted-foreground/70">{t('weldhr.employees.workspace.notLinkedShort')}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {canLink && (
            <DropdownMenuItem onClick={openLink}>
              <Link2 />
              {emailMatch ? t('weldhr.employees.workspace.linkMatching') : t('weldhr.employees.workspace.linkExisting')}
            </DropdownMenuItem>
          )}
          {canInvite && (
            <DropdownMenuItem onClick={openInvite}>
              <UserPlus />
              {t('weldhr.employees.workspace.invite')}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  } else {
    value = <span className={`${VALUE_BOX} text-muted-foreground`}>{t('weldhr.employees.workspace.notLinkedShort')}</span>;
  }

  return (
    <>
      <div className="grid grid-cols-[120px_minmax(0,1fr)_auto] gap-2 items-center group/row min-h-[32px]">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Icon className="h-4 w-4" />
          <span>{t('weldhr.employees.detail.fields.workspaceAccount')}</span>
        </div>
        <div className="min-w-0 flex">{value}</div>
        <div />
      </div>

      {dialog === 'invite' && (
        <Dialog open onOpenChange={(open) => !open && !pending && setDialog(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader className="mb-2">
              <DialogTitle>{t('weldhr.employees.workspace.inviteTitle')}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />
              <p className="text-sm text-muted-foreground">
                {t('weldhr.employees.workspace.inviteDescription', {
                  name: employee.displayName,
                  email: employee.email,
                })}
              </p>
              <div className="space-y-2">
                <Label>{t('weldhr.employees.workspace.inviteAs')}</Label>
                <Select value={inviteAs} onValueChange={(v) => setInviteAs(v as InviteAs)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="EMPLOYEE">{t('weldhr.employees.workspace.inviteAsEmployee')}</SelectItem>
                    <SelectItem value="INTERNAL">{t('weldhr.employees.workspace.inviteAsTeamMember')}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {inviteAs === 'EMPLOYEE'
                    ? t('weldhr.employees.workspace.inviteAsEmployeeHint')
                    : t('weldhr.employees.workspace.inviteAsTeamMemberHint')}
                </p>
              </div>
              {inviteAs === 'INTERNAL' && (
                <div className="space-y-2">
                  <Label>{t('weldhr.employees.workspace.role')}</Label>
                  <Select value={roleId || '__none'} onValueChange={(v) => setRoleId(v === '__none' ? '' : v)}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {roles.map((role) => (
                        <SelectItem key={role.id} value={role.id}>
                          {role.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialog(null)} disabled={pending}>
                {t('weldhr.common.cancel')}
              </Button>
              <Button
                type="button"
                onClick={() => void inviteMember()}
                disabled={pending || (inviteAs === 'INTERNAL' && !roleId)}
              >
                {pending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Send className="mr-1.5 h-4 w-4" />}
                {t('weldhr.employees.workspace.inviteSubmit')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {dialog === 'link' && (
        <Dialog open onOpenChange={(open) => !open && !pending && setDialog(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader className="mb-2">
              <DialogTitle>{t('weldhr.employees.workspace.linkTitle')}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />
              <p className="text-sm text-muted-foreground">{t('weldhr.employees.workspace.linkDescription')}</p>
              {emailMatch && (
                <p className="text-xs text-muted-foreground">
                  {t('weldhr.employees.workspace.emailMatchHint', {
                    name: emailMatch.name || memberEmail(emailMatch) || emailMatch.userId,
                  })}
                </p>
              )}
              <div className="space-y-2">
                <Label>{t('weldhr.employees.create.teamMember')}</Label>
                <Select value={selectedUserId || '__none'} onValueChange={(v) => setSelectedUserId(v === '__none' ? '' : v)}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t('weldhr.employees.create.teamMemberPlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">{t('weldhr.employees.create.teamMemberPlaceholder')}</SelectItem>
                    {linkableMembers.map((member) => (
                      <SelectItem key={member.userId} value={member.userId}>
                        {member.name || memberEmail(member) || member.userId}
                        {memberEmail(member) ? ` · ${memberEmail(member)}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialog(null)} disabled={pending}>
                {t('weldhr.common.cancel')}
              </Button>
              <Button type="button" onClick={() => void linkMember()} disabled={pending || !selectedUserId}>
                {pending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Link2 className="mr-1.5 h-4 w-4" />}
                {t('weldhr.employees.workspace.linkSubmit')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
