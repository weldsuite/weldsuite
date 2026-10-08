/**
 * Workspace account card on the employee detail page.
 *
 * New employees are always created from a workspace member, so this card only
 * has work to do for employees from before that rule: link them to an
 * existing member, or invite them (as an Employee member by default, which
 * gives them My HR and WeldChat only) and link them once they've accepted.
 */

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Link2, Loader2, Send, UserPlus } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
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
import { useAppApi } from '@/lib/api/use-app-api';
import { useTeamMembers } from '@/hooks/queries/use-team-queries';
import { useWorkspaceRoles } from '@/hooks/queries/use-settings-queries';
import { useHrAvailableMembers, useUpdateHrEmployee } from '@/hooks/queries/use-weldhr-queries';
import { ErrorBanner, errorMessage } from '../../components/shared';
import { EmptyText, SectionCard } from '../../components/page-kit';

type Props = Readonly<{
  employee: HrEmployeeDetail;
}>;

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

export function EmployeeWorkspaceMemberCard({ employee }: Props) {
  const t = useTranslations();
  const { can } = usePermissions();
  const { teamMembers } = useAppApi();
  const updateEmployee = useUpdateHrEmployee();
  const canReadTeam = can('team:read');
  const canInvite = can('team:create');
  // PATCH /employees/:id (the link) and the available-members list both need employees:update.
  const canLink = can('employees:update');

  // Only to show who a linked employee is; every member type, since the
  // linked member is often an EMPLOYEE member.
  const { data: membersResponse } = useTeamMembers(
    canReadTeam && employee.userId ? { limit: 100, status: 'ACTIVE', memberType: 'all' } : undefined,
  );
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

  const linkedMember = useMemo(() => {
    if (!employee.userId) return null;
    return (membersResponse?.data ?? []).find((m) => m.userId === employee.userId) ?? null;
  }, [employee.userId, membersResponse]);

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

  let body;
  if (employee.userId) {
    body = (
      <div className="space-y-2">
        <p className="text-sm">
          {t('weldhr.employees.workspace.linkedAs', {
            name: linkedMember?.name || (linkedMember ? memberEmail(linkedMember) : null) || employee.userId,
          })}
        </p>
        {linkedMember && memberEmail(linkedMember) && (
          <p className="text-xs text-muted-foreground">{memberEmail(linkedMember)}</p>
        )}
      </div>
    );
  } else {
    body = (
      <div className="space-y-3">
        <EmptyText>{t('weldhr.employees.workspace.notLinked')}</EmptyText>
        {emailMatch && (
          <p className="text-xs text-muted-foreground">
            {t('weldhr.employees.workspace.emailMatchHint', {
              name: emailMatch.name || memberEmail(emailMatch) || emailMatch.userId,
            })}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {canLink && (
            <Button size="sm" variant="outline" onClick={openLink}>
              <Link2 className="mr-1.5 h-4 w-4" />
              {emailMatch
                ? t('weldhr.employees.workspace.linkMatching')
                : t('weldhr.employees.workspace.linkExisting')}
            </Button>
          )}
          {canInvite && (
            <Button size="sm" onClick={openInvite}>
              <UserPlus className="mr-1.5 h-4 w-4" />
              {t('weldhr.employees.workspace.invite')}
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      <SectionCard title={t('weldhr.employees.workspace.title')}>{body}</SectionCard>

      {dialog === 'invite' && (
        <Dialog open onOpenChange={(open) => !open && !pending && setDialog(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
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
            <DialogHeader>
              <DialogTitle>{t('weldhr.employees.workspace.linkTitle')}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />
              <p className="text-sm text-muted-foreground">{t('weldhr.employees.workspace.linkDescription')}</p>
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
