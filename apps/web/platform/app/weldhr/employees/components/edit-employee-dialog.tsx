/** Edit dialog for an employee's public profile fields. */

import { useState } from 'react';
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
import type { HrEmployeeDetail } from '@weldsuite/app-api-client/domains/weldhr';
import { useHrDepartments, useUpdateHrEmployee } from '@/hooks/queries/use-weldhr-queries';
import { EmployeePicker, ErrorBanner, errorMessage } from '../../components/shared';

const formSchema = z.object({
  employeeNumber: z.string().trim().optional(),
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  preferredName: z.string().trim().optional(),
  pronouns: z.string().trim().optional(),
  email: z.string().trim().email(),
  phone: z.string().trim().optional(),
  jobTitle: z.string().trim().optional(),
  employmentType: hrEmploymentTypeSchema,
  status: hrEmployeeStatusSchema,
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  probationEndDate: z.string().optional(),
  location: z.string().trim().optional(),
  timezone: z.string().trim().optional(),
  weeklyHours: z.union([z.string(), z.number()]).optional(),
  departmentId: z.string().optional(),
  managerId: z.string().optional(),
});

type FormValues = z.infer<typeof formSchema>;

export function EditEmployeeDialog({ employee, onClose }: { employee: HrEmployeeDetail; onClose: () => void }) {
  const t = useTranslations();
  const updateEmployee = useUpdateHrEmployee();
  const { data: departments } = useHrDepartments();
  const [managerLabel, setManagerLabel] = useState<string | null>(employee.managerName);
  const [failure, setFailure] = useState<string | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      employeeNumber: employee.employeeNumber ?? '',
      firstName: employee.firstName,
      lastName: employee.lastName,
      preferredName: employee.preferredName ?? '',
      pronouns: employee.pronouns ?? '',
      email: employee.email,
      phone: employee.phone ?? '',
      jobTitle: employee.jobTitle ?? '',
      employmentType: employee.employmentType,
      status: employee.status,
      startDate: employee.startDate ?? '',
      endDate: employee.endDate ?? '',
      probationEndDate: employee.probationEndDate ?? '',
      location: employee.location ?? '',
      timezone: employee.timezone ?? '',
      weeklyHours: employee.weeklyHours ?? undefined,
      departmentId: employee.departmentId ?? undefined,
      managerId: employee.managerId ?? undefined,
    },
  });

  async function onSubmit(values: FormValues) {
    setFailure(null);
    try {
      await updateEmployee.mutateAsync({
        id: employee.id,
        employeeNumber: values.employeeNumber?.trim() || null,
        firstName: values.firstName.trim(),
        lastName: values.lastName.trim(),
        preferredName: values.preferredName?.trim() || null,
        pronouns: values.pronouns?.trim() || null,
        email: values.email.trim(),
        phone: values.phone?.trim() || null,
        jobTitle: values.jobTitle?.trim() || null,
        employmentType: values.employmentType,
        status: values.status,
        startDate: values.startDate || null,
        endDate: values.endDate || null,
        probationEndDate: values.probationEndDate || null,
        location: values.location?.trim() || null,
        timezone: values.timezone?.trim() || null,
        weeklyHours: values.weeklyHours === '' || values.weeklyHours === undefined ? null : Number(values.weeklyHours),
        departmentId: values.departmentId || null,
        managerId: values.managerId || null,
      });
      onClose();
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.employees.detail.edit.failed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !updateEmployee.isPending && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('weldhr.employees.detail.edit.title')}</DialogTitle>
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

            <div className="grid grid-cols-2 gap-3">
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
              <FormField
                control={form.control}
                name="pronouns"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('weldhr.employees.detail.overview.pronouns')}</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

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

            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="employeeNumber"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('weldhr.employees.detail.overview.employeeNumber')}</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
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
            </div>

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

            <div className="grid grid-cols-3 gap-3">
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
              <FormField
                control={form.control}
                name="probationEndDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('weldhr.employees.detail.overview.probationEndDate')}</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="endDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('weldhr.employees.detail.overview.endDate')}</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

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
                  excludeId={employee.id}
                  onChange={(id, label) => {
                    form.setValue('managerId', id ?? undefined);
                    setManagerLabel(label);
                  }}
                  allowClear
                />
              </FormItem>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <FormField
                control={form.control}
                name="location"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('weldhr.employees.detail.overview.location')}</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="timezone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('weldhr.employees.detail.overview.timezone')}</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="weeklyHours"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('weldhr.employees.detail.overview.weeklyHours')}</FormLabel>
                    <FormControl>
                      <Input type="number" min={0} max={168} step="0.5" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={updateEmployee.isPending}>
                {t('weldhr.common.cancel')}
              </Button>
              <Button type="submit" disabled={updateEmployee.isPending}>
                {updateEmployee.isPending ? t('weldhr.common.saving') : t('weldhr.common.save')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
