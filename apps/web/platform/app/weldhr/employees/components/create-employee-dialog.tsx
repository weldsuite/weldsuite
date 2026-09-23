/** "New employee" dialog: core fields, optional onboarding checklist, optional first client assignment. */

import { useState } from 'react';
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
import {
  hrEmployeeStatusSchema,
  hrEmploymentTypeSchema,
} from '@weldsuite/app-api-client/schemas/weldhr';
import {
  useCreateHrAssignment,
  useCreateHrEmployee,
  useHrChecklistTemplates,
  useHrDepartments,
} from '@/hooks/queries/use-weldhr-queries';
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

export function CreateEmployeeDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations();
  const navigate = useNavigate();
  const createEmployee = useCreateHrEmployee();
  const createAssignment = useCreateHrAssignment();
  const { data: departments } = useHrDepartments();
  const { data: templates } = useHrChecklistTemplates('onboarding');
  const [managerLabel, setManagerLabel] = useState<string | null>(null);
  const [companyLabel, setCompanyLabel] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const defaultTemplateId = templates?.find((tpl) => tpl.isDefault)?.id;

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

  const isSubmitting = createEmployee.isPending || createAssignment.isPending;

  async function onSubmit(values: FormValues) {
    setFailure(null);
    try {
      const created = await createEmployee.mutateAsync({
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
      });

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
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? t('weldhr.common.saving') : t('weldhr.employees.create.submit')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
