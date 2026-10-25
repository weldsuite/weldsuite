/**
 * "New employee" dialog. Every employee is someone in this workspace, so the
 * dialog either starts from a workspace member (INTERNAL or EMPLOYEE, not
 * linked to an employee yet) and prefills the form from them, or invites
 * someone new: one submit sends the workspace invitation and creates the
 * employee, which hr-api links to them as soon as they accept. That way HR
 * fills in the record once and the new hire logs their own hours in My HR.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Tabs, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import {
  hrEmployeeStatusSchema,
  hrEmploymentTypeSchema,
} from '@weldsuite/app-api-client/schemas/weldhr';
import type { CreateHrEmployeeInput } from '@weldsuite/app-api-client/schemas/weldhr';
import type { HrAvailableMember } from '@weldsuite/app-api-client/domains/weldhr';
import { useAppApi } from '@/lib/api/use-app-api';
import { useWorkspaceRoles } from '@/hooks/queries/use-settings-queries';
import {
  useCreateHrEmployee,
  useCreateHrEmployeeFromMember,
  useHrAvailableMembers,
  useHrDepartments,
} from '@/hooks/queries/use-weldhr-queries';
import {
  EmployeePicker,
  ErrorBanner,
  errorMessage,
  todayIso,
} from '../../components/shared';
import { employeeFieldRules } from './employee-field-rules';

function buildFormSchema(t: (path: string) => string) {
  return z.object({
    ...employeeFieldRules(t),
    preferredName: z.string().trim().optional(),
    jobTitle: z.string().trim().optional(),
    employmentType: hrEmploymentTypeSchema,
    status: hrEmployeeStatusSchema,
    startDate: z.string().optional(),
    departmentId: z.string().optional(),
    managerId: z.string().optional(),
  });
}

type FormValues = z.infer<ReturnType<typeof buildFormSchema>>;

type Mode = 'member' | 'invite';
type InviteAs = 'EMPLOYEE' | 'INTERNAL';

function splitName(name: string | null | undefined): { firstName: string; lastName: string } {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0]!, lastName: parts[0]! };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(' ') };
}

function memberLabel(member: HrAvailableMember): string {
  const name = member.name || member.email || member.userId;
  return member.email && member.name ? `${name} · ${member.email}` : name;
}

function pickDefaultRoleId(roles: Array<{ id: string; name: string }>): string {
  const member = roles.find((r) => r.name.toUpperCase() === 'MEMBER');
  const viewer = roles.find((r) => r.name.toUpperCase() === 'VIEWER');
  return (member ?? viewer ?? roles[0])?.id ?? '';
}

/** 409 from the invite: they are already a member or already invited, and the create step takes it from there. */
function isConflict(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'status' in err && (err as { status?: unknown }).status === 409;
}

/**
 * Invite someone new and create their employee record. The email is checked
 * against the directory first, and an invitation this call sent is withdrawn
 * when the create step still fails. Withdrawing takes `team:delete`, which
 * inviting (`team:create`) does not imply; when it fails the error says the
 * invitation is still open, so it can be cancelled in Settings → Team instead
 * of holding a paid seat unnoticed. Resolves to the new employee's id.
 */
function useInviteAndCreate() {
  const t = useTranslations();
  const { teamMembers, weldhr } = useAppApi();
  const createEmployee = useCreateHrEmployee();

  return async (input: CreateHrEmployeeInput, invite: { as: InviteAs; roleId: string }): Promise<string> => {
    const email = input.email.toLowerCase();
    // Needs employees:read; without it the create step's own check and the withdrawal below still apply.
    const sameEmail = await weldhr.listEmployees({ search: input.email, limit: 20 }).catch(() => null);
    if (sameEmail?.data.some((e) => e.email.toLowerCase() === email)) {
      throw new Error(t('weldhr.employees.create.emailTaken'));
    }

    let sentMemberId: string | null = null;
    try {
      const sent = await teamMembers.inviteMember({
        email: input.email,
        name: `${input.firstName} ${input.lastName}`.trim(),
        // An Employee member's access is fixed; the server ignores a role for them.
        roleId: invite.as === 'INTERNAL' ? invite.roleId || null : null,
        memberType: invite.as,
      });
      sentMemberId = sent.data.memberId;
    } catch (err) {
      if (!isConflict(err)) throw new Error(errorMessage(err, t('weldhr.employees.workspace.inviteFailed')));
    }

    try {
      return (await createEmployee.mutateAsync(input)).data.id;
    } catch (err) {
      const failed = errorMessage(err, t('weldhr.employees.create.failed'));
      if (!sentMemberId) throw new Error(failed);
      const withdrawn = await teamMembers.removeMember(sentMemberId).then(() => true, () => false);
      if (withdrawn) throw new Error(failed);
      throw new Error(`${failed} ${t('weldhr.employees.create.inviteNotWithdrawn', { email: input.email })}`);
    }
  };
}

export function CreateEmployeeDialog({
  onClose,
  defaultUserId,
  onCreated,
}: Readonly<{
  onClose: () => void;
  /** Preselect this workspace member (My HR's "add me as an employee"). */
  defaultUserId?: string;
  /** Replaces the default of opening the new employee's profile. */
  onCreated?: (employeeId: string) => void;
}>) {
  const t = useTranslations();
  const formSchema = useMemo(() => buildFormSchema(t), [t]);
  const navigate = useNavigate();
  const { can } = usePermissions();
  const createFromMember = useCreateHrEmployeeFromMember();
  const inviteAndCreate = useInviteAndCreate();
  const { data: departments } = useHrDepartments();
  const { data: availableMembers, isLoading: membersLoading } = useHrAvailableMembers({ limit: 200 });
  // Inviting takes a paid seat, so it needs team:create like Settings → Team does.
  const canInvite = can('team:create');
  const { data: rolesResponse } = useWorkspaceRoles(canInvite);
  const roles = useMemo(() => rolesResponse?.data ?? [], [rolesResponse]);

  const [chosenMode, setChosenMode] = useState<Mode | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string | undefined>(undefined);
  const [inviteAs, setInviteAs] = useState<InviteAs>('EMPLOYEE');
  const [roleId, setRoleId] = useState<string>('');
  const [inviting, setInviting] = useState(false);
  const [managerLabel, setManagerLabel] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const members = availableMembers ?? [];
  // Nobody left to pick: start on the invite side.
  const mode: Mode = chosenMode ?? (canInvite && !defaultUserId && !membersLoading && members.length === 0 ? 'invite' : 'member');

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      firstName: '',
      lastName: '',
      preferredName: '',
      email: '',
      phone: '',
      jobTitle: '',
      employmentType: 'full_time',
      status: 'onboarding',
      startDate: todayIso(),
      departmentId: undefined,
      managerId: undefined,
    },
  });

  const isSubmitting = createFromMember.isPending || inviting;

  useEffect(() => {
    if (!roleId && roles.length) setRoleId(pickDefaultRoleId(roles));
  }, [roleId, roles]);

  // Preselect `defaultUserId` once the member list has it.
  const [preselected, setPreselected] = useState(false);
  useEffect(() => {
    if (preselected || !defaultUserId || !members.some((m) => m.userId === defaultUserId)) return;
    setPreselected(true);
    selectMember(defaultUserId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectMember only reads `members`, already a dependency
  }, [defaultUserId, members, preselected]);

  function switchMode(next: Mode) {
    setChosenMode(next);
    setFailure(null);
    if (next === 'invite') {
      setSelectedUserId(undefined);
      form.reset({ ...form.getValues(), firstName: '', lastName: '', email: '', phone: '', jobTitle: '' });
    }
  }

  function selectMember(userId: string | undefined) {
    setSelectedUserId(userId);
    setFailure(null);
    const member = members.find((m) => m.userId === userId);
    if (!member) return;
    const names = splitName(member.name);
    form.setValue('firstName', names.firstName);
    form.setValue('lastName', names.lastName);
    form.setValue('email', member.email ?? '');
    form.setValue('phone', member.phone ?? '');
    form.setValue('jobTitle', member.title ?? '');
  }

  function employeeFields(values: FormValues) {
    return {
      firstName: values.firstName.trim(),
      lastName: values.lastName.trim(),
      preferredName: values.preferredName?.trim() || null,
      email: values.email.trim(),
      phone: values.phone?.trim() || null,
      jobTitle: values.jobTitle?.trim() || null,
      employmentType: values.employmentType,
      status: values.status,
      startDate: values.startDate || null,
      departmentId: values.departmentId || null,
      managerId: values.managerId || null,
    };
  }

  function finish(employeeId: string) {
    onClose();
    if (onCreated) onCreated(employeeId);
    else void navigate({ to: '/weldhr/employees/$employeeId', params: { employeeId } });
  }

  async function submitInvite(values: FormValues) {
    setInviting(true);
    try {
      const employeeId = await inviteAndCreate(employeeFields(values), { as: inviteAs, roleId });
      toast.success(t('weldhr.employees.create.invitedAndCreated', { email: values.email.trim() }));
      finish(employeeId);
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.employees.create.failed')));
    } finally {
      setInviting(false);
    }
  }

  async function onSubmit(values: FormValues) {
    setFailure(null);
    if (mode === 'invite') {
      await submitInvite(values);
      return;
    }

    if (!selectedUserId) {
      setFailure(t('weldhr.employees.create.memberRequired'));
      return;
    }
    try {
      const created = await createFromMember.mutateAsync({ userId: selectedUserId, ...employeeFields(values) });
      finish(created.data.id);
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.employees.create.failed')));
    }
  }

  const showFields = mode === 'invite' || Boolean(selectedUserId);
  const canSubmit = mode === 'invite' ? !(inviteAs === 'INTERNAL' && !roleId) : Boolean(selectedUserId);

  return (
    <Dialog open onOpenChange={(open) => !open && !isSubmitting && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('weldhr.employees.create.title')}</DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

            {canInvite && !defaultUserId && (
              <Tabs value={mode} onValueChange={(v) => switchMode(v as Mode)}>
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="member" disabled={isSubmitting}>{t('weldhr.employees.create.modeMember')}</TabsTrigger>
                  <TabsTrigger value="invite" disabled={isSubmitting}>{t('weldhr.employees.create.modeInvite')}</TabsTrigger>
                </TabsList>
              </Tabs>
            )}

            {mode === 'member' ? (
              <div className="space-y-2">
                <Label>{t('weldhr.employees.create.member')}</Label>
                <Select
                  value={selectedUserId ?? '__none'}
                  onValueChange={(v) => selectMember(v === '__none' ? undefined : v)}
                  disabled={membersLoading || members.length === 0}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t('weldhr.employees.create.memberPlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">{t('weldhr.employees.create.memberPlaceholder')}</SelectItem>
                    {members.map((member) => (
                      <SelectItem key={member.userId} value={member.userId}>
                        {memberLabel(member)}
                        {member.memberType === 'EMPLOYEE' && (
                          <span className="ml-1.5 text-xs text-muted-foreground">
                            ({t('weldhr.employees.create.employeeMemberTag')})
                          </span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {!membersLoading && members.length === 0
                    ? t('weldhr.employees.create.noMembersAvailable')
                    : t('weldhr.employees.create.memberHint')}
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">{t('weldhr.employees.create.inviteHint')}</p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label>{t('weldhr.employees.workspace.inviteAs')}</Label>
                    <Select value={inviteAs} onValueChange={(v) => setInviteAs(v as InviteAs)} disabled={isSubmitting}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="EMPLOYEE">{t('weldhr.employees.workspace.inviteAsEmployee')}</SelectItem>
                        <SelectItem value="INTERNAL">{t('weldhr.employees.workspace.inviteAsTeamMember')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {inviteAs === 'INTERNAL' && (
                    <div className="space-y-2">
                      <Label>{t('weldhr.employees.workspace.role')}</Label>
                      <Select value={roleId || '__none'} onValueChange={(v) => setRoleId(v === '__none' ? '' : v)} disabled={isSubmitting}>
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
                <p className="text-xs text-muted-foreground">
                  {inviteAs === 'EMPLOYEE'
                    ? t('weldhr.employees.workspace.inviteAsEmployeeHint')
                    : t('weldhr.employees.workspace.inviteAsTeamMemberHint')}
                </p>
              </div>
            )}

            {showFields && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="firstName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('weldhr.employees.create.firstName')}</FormLabel>
                        <FormControl>
                          <Input {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="lastName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('weldhr.employees.create.lastName')}</FormLabel>
                        <FormControl>
                          <Input {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="preferredName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('weldhr.employees.create.preferredName')}</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('weldhr.employees.create.email')}</FormLabel>
                        <FormControl>
                          <Input type="email" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="phone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('weldhr.employees.create.phone')}</FormLabel>
                        <FormControl>
                          <Input {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="jobTitle"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('weldhr.employees.create.jobTitle')}</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="employmentType"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('weldhr.employees.create.employmentType')}</FormLabel>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {hrEmploymentTypeSchema.options.map((opt) => (
                              <SelectItem key={opt} value={opt}>
                                {t(`weldhr.status.employmentType.${opt}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="status"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('weldhr.employees.create.status')}</FormLabel>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {hrEmployeeStatusSchema.options.map((opt) => (
                              <SelectItem key={opt} value={opt}>
                                {t(`weldhr.status.employee.${opt}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="startDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('weldhr.employees.create.startDate')}</FormLabel>
                      <FormControl>
                        <Input type="date" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="departmentId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{t('weldhr.employees.create.department')}</FormLabel>
                        <Select value={field.value ?? '__none'} onValueChange={(v) => field.onChange(v === '__none' ? undefined : v)}>
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="__none">{t('weldhr.common.none')}</SelectItem>
                            {(departments ?? []).map((dep) => (
                              <SelectItem key={dep.id} value={dep.id}>
                                {dep.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormItem>
                    <Label>{t('weldhr.employees.create.manager')}</Label>
                    <EmployeePicker
                      value={form.watch('managerId') ?? null}
                      valueLabel={managerLabel}
                      onChange={(id, label) => {
                        form.setValue('managerId', id ?? undefined);
                        setManagerLabel(label);
                      }}
                      allowClear
                    />
                  </FormItem>
                </div>
              </>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
                {t('weldhr.common.cancel')}
              </Button>
              <Button type="submit" disabled={isSubmitting || !canSubmit}>
                {isSubmitting && t('weldhr.common.saving')}
                {!isSubmitting && mode === 'invite' && t('weldhr.employees.create.inviteAndCreate')}
                {!isSubmitting && mode === 'member' && t('weldhr.employees.create.submit')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
