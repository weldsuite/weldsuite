/** "New employee" dialog: blank form or prefill from an active workspace member. */

import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
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
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import {
  hrEmployeeStatusSchema,
  hrEmploymentTypeSchema,
} from '@weldsuite/app-api-client/schemas/weldhr';
import {
  useCreateHrAssignment,
  useCreateHrEmployee,
  useCreateHrEmployeeFromMember,
  useHrChecklistTemplates,
  useHrDepartments,
  useHrEmployees,
} from '@/hooks/queries/use-weldhr-queries';
import { useTeamMembers } from '@/hooks/queries/use-team-queries';
import {
  EmployeePicker,
  CompanyPicker,
  ErrorBanner,
  errorMessage,
  todayIso,
} from '../../components/shared';

const formSchema = z.object({
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  preferredName: z.string().trim().optional(),
  email: z.string().trim().email(),
  phone: z.string().trim().optional(),
  jobTitle: z.string().trim().optional(),
  employmentType: hrEmploymentTypeSchema,
  status: hrEmployeeStatusSchema,
  startDate: z.string().optional(),
  departmentId: z.string().optional(),
  managerId: z.string().optional(),
  onboardingTemplateId: z.string().optional(),
  assignCompanyId: z.string().optional(),
  assignRole: z.string().trim().optional(),
});

type FormValues = z.infer<typeof formSchema>;
type CreateMode = 'blank' | 'fromMember';

function memberEmail(member: { email?: string | null } | object): string | null {
  return 'email' in member && typeof member.email === 'string' ? member.email : null;
}

function splitName(name: string | null | undefined): { firstName: string; lastName: string } {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0]!, lastName: parts[0]! };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(' ') };
}

export function CreateEmployeeDialog({ onClose }: Readonly<{ onClose: () => void }>) {
  const t = useTranslations();
  const navigate = useNavigate();
  const { can } = usePermissions();
  const createEmployee = useCreateHrEmployee();
  const createFromMember = useCreateHrEmployeeFromMember();
  const createAssignment = useCreateHrAssignment();
  const { data: departments } = useHrDepartments();
  const { data: templates } = useHrChecklistTemplates('onboarding');
  const canReadTeam = can('team:read');
  const { data: membersResponse } = useTeamMembers(
    canReadTeam ? { limit: 100, status: 'ACTIVE', memberType: 'INTERNAL' } : undefined,
  );
  const { data: linkedEmployees } = useHrEmployees({ limit: 200 });
  const [mode, setMode] = useState<CreateMode>('blank');
  const [selectedUserId, setSelectedUserId] = useState<string | undefined>(undefined);
  const [managerLabel, setManagerLabel] = useState<string | null>(null);
  const [companyLabel, setCompanyLabel] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const defaultTemplateId = templates?.find((tpl) => tpl.isDefault)?.id;

  const linkedUserIds = useMemo(() => {
    const ids = new Set<string>();
    for (const emp of linkedEmployees?.data ?? []) {
      if (emp.userId) ids.add(emp.userId);
    }
    return ids;
  }, [linkedEmployees]);

  const availableMembers = useMemo(() => {
    const members = membersResponse?.data ?? [];
    return members.filter(
      (m) =>
        m.status === 'ACTIVE' &&
        m.memberType !== 'EXTERNAL_GUEST' &&
        !m.userId.startsWith('invited_') &&
        !linkedUserIds.has(m.userId),
    );
  }, [membersResponse, linkedUserIds]);

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
      onboardingTemplateId: undefined,
      assignCompanyId: undefined,
      assignRole: '',
    },
  });

  const isSubmitting =
    createEmployee.isPending || createFromMember.isPending || createAssignment.isPending;

  function applyMember(userId: string) {
    const member = availableMembers.find((m) => m.userId === userId);
    setSelectedUserId(userId);
    if (!member) return;
    const names = splitName(member.name);
    form.setValue('firstName', names.firstName);
    form.setValue('lastName', names.lastName);
    form.setValue('email', memberEmail(member) ?? '');
    if ('phone' in member && typeof member.phone === 'string') {
      form.setValue('phone', member.phone);
    }
  }

  function switchMode(next: CreateMode) {
    setMode(next);
    setFailure(null);
    setSelectedUserId(undefined);
    form.reset({
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
      onboardingTemplateId: undefined,
      assignCompanyId: undefined,
      assignRole: '',
    });
    setManagerLabel(null);
    setCompanyLabel(null);
  }

  async function onSubmit(values: FormValues) {
    setFailure(null);
    if (mode === 'fromMember' && !selectedUserId) {
      setFailure(t('weldhr.employees.create.fromMemberRequired'));
      return;
    }
    try {
      const payload = {
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
        onboardingTemplateId: values.onboardingTemplateId || undefined,
      };

      const created =
        mode === 'fromMember' && selectedUserId
          ? await createFromMember.mutateAsync({ ...payload, userId: selectedUserId })
          : await createEmployee.mutateAsync(payload);

      if (values.assignCompanyId) {
        try {
          await createAssignment.mutateAsync({
            employeeId: created.data.id,
            companyId: values.assignCompanyId,
            role: values.assignRole?.trim() || null,
            startDate: values.startDate || todayIso(),
            isPrimary: true,
          });
        } catch {
          // The employee was created; a failed first assignment shouldn't block navigation.
        }
      }

      onClose();
      void navigate({ to: '/weldhr/employees/$employeeId', params: { employeeId: created.data.id } });
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.employees.create.failed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !isSubmitting && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('weldhr.employees.create.title')}</DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

            {canReadTeam && (
              <div className="space-y-2">
                <Label>{t('weldhr.employees.create.sourceLabel')}</Label>
                <Select value={mode} onValueChange={(v) => switchMode(v as CreateMode)}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="blank">{t('weldhr.employees.create.sourceBlank')}</SelectItem>
                    <SelectItem value="fromMember">{t('weldhr.employees.create.sourceFromMember')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {mode === 'fromMember' && (
              <div className="space-y-2">
                <Label>{t('weldhr.employees.create.teamMember')}</Label>
                <Select
                  value={selectedUserId ?? '__none'}
                  onValueChange={(v) => {
                    if (v === '__none') {
                      setSelectedUserId(undefined);
                      return;
                    }
                    applyMember(v);
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t('weldhr.employees.create.teamMemberPlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">{t('weldhr.employees.create.teamMemberPlaceholder')}</SelectItem>
                    {availableMembers.map((member) => (
                      <SelectItem key={member.userId} value={member.userId}>
                        {member.name || memberEmail(member) || member.userId}
                        {memberEmail(member) ? ` · ${memberEmail(member)}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {availableMembers.length === 0 && (
                  <p className="text-xs text-muted-foreground">{t('weldhr.employees.create.noMembersAvailable')}</p>
                )}
              </div>
            )}

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

            <FormField
              control={form.control}
              name="onboardingTemplateId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('weldhr.employees.create.onboarding')}</FormLabel>
                  <Select
                    value={field.value ?? defaultTemplateId ?? '__none'}
                    onValueChange={(v) => field.onChange(v === '__none' ? undefined : v)}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="__none">{t('weldhr.employees.create.onboardingNone')}</SelectItem>
                      {(templates ?? []).map((tpl) => (
                        <SelectItem key={tpl.id} value={tpl.id}>
                          {tpl.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="space-y-3 rounded-md border p-3">
              <p className="text-xs font-medium text-muted-foreground">{t('weldhr.employees.create.firstClient')}</p>
              <div className="grid grid-cols-2 gap-3">
                <FormItem>
                  <Label>{t('weldhr.common.client')}</Label>
                  <CompanyPicker
                    value={form.watch('assignCompanyId') ?? null}
                    valueLabel={companyLabel}
                    onChange={(id, label) => {
                      form.setValue('assignCompanyId', id ?? undefined);
                      setCompanyLabel(label);
                    }}
                    allowClear
                  />
                </FormItem>
                <FormField
                  control={form.control}
                  name="assignRole"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('weldhr.employees.create.role')}</FormLabel>
                      <FormControl>
                        <Input {...field} disabled={!form.watch('assignCompanyId')} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
                {t('weldhr.common.cancel')}
              </Button>
              <Button type="submit" disabled={isSubmitting || (mode === 'fromMember' && !selectedUserId)}>
                {isSubmitting ? t('weldhr.common.saving') : t('weldhr.employees.create.submit')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
