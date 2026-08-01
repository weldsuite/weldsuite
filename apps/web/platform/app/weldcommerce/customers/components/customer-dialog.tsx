import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { createCompanySchema } from '@weldsuite/app-api-client/schemas/companies';
import type { Company, CreateCompanyInput } from '@weldsuite/app-api-client/schemas/companies';
import { createPersonSchema } from '@weldsuite/core-api-client/schemas/people';
import type { Person, CreatePersonInput } from '@weldsuite/core-api-client/schemas/people';
import { useCreateCompany, useUpdateCompany } from '@/components/objects/company/use-company-data';
import { useCreatePerson, useUpdatePerson } from '@/components/objects/person/use-person-data';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Tabs, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';
import type { CustomerKind, CustomerRow } from '../config/customer-row';

type CompanyValues = z.input<typeof createCompanySchema>;
type PersonValues = z.input<typeof createPersonSchema>;

/**
 * Create + edit form for a customer, which may be either object.
 *
 * On create the kind is switchable; on edit it's fixed — a company can't be
 * turned into a person, they're different rows in different tables.
 */
export function CustomerDialog({
  open,
  onOpenChange,
  customer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customer?: CustomerRow;
}) {
  const t = getTranslations('commerce').module;
  const isEdit = !!customer;
  const [kind, setKind] = useState<CustomerKind>(customer?.kind ?? 'company');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? t.customers.editTitle : t.customers.newTitle}</DialogTitle>
        </DialogHeader>

        {!isEdit && (
          <Tabs value={kind} onValueChange={(v) => setKind(v as CustomerKind)}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="company">{t.customers.kindCompany}</TabsTrigger>
              <TabsTrigger value="person">{t.customers.kindPerson}</TabsTrigger>
            </TabsList>
          </Tabs>
        )}

        {kind === 'company' ? (
          <CompanyForm
            company={customer?.kind === 'company' ? (customer.source as Company) : undefined}
            onDone={() => onOpenChange(false)}
            onCancel={() => onOpenChange(false)}
          />
        ) : (
          <PersonForm
            person={customer?.kind === 'person' ? (customer.source as Person) : undefined}
            onDone={() => onOpenChange(false)}
            onCancel={() => onOpenChange(false)}
          />
        )}

        <p className="text-xs text-muted-foreground">{t.customers.sharedWithCrm}</p>
      </DialogContent>
    </Dialog>
  );
}

function CompanyForm({
  company,
  onDone,
  onCancel,
}: {
  company?: Company;
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = getTranslations('commerce').module;
  const tc = getTranslations('common');
  const isEdit = !!company;
  const create = useCreateCompany();
  const update = useUpdateCompany();

  const form = useForm<CompanyValues>({
    resolver: zodResolver(createCompanySchema),
    defaultValues: company
      ? {
          name: company.name,
          email: company.email ?? undefined,
          phone: company.phone ?? undefined,
          website: company.website ?? undefined,
          industry: company.industry ?? undefined,
        }
      : { name: '' },
  });

  const onSubmit = async (values: CompanyValues) => {
    try {
      const parsed = createCompanySchema.parse(values) as CreateCompanyInput;
      if (isEdit && company) {
        await update.mutateAsync({ id: company.id, data: parsed });
        toast.success(t.customers.toastUpdated);
      } else {
        await create.mutateAsync(parsed);
        toast.success(t.customers.toastCreated);
      }
      onDone();
      form.reset();
    } catch (err) {
      toast.error((err as Error).message || t.common.saveFailed);
    }
  };

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="company-name">{t.fields.name}</Label>
        <Input id="company-name" {...form.register('name')} />
        {form.formState.errors.name && (
          <p className="text-xs text-destructive">{String(form.formState.errors.name.message ?? '')}</p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="company-email">{t.fields.email}</Label>
          <Input id="company-email" type="email" {...form.register('email')} />
          {form.formState.errors.email && (
            <p className="text-xs text-destructive">{String(form.formState.errors.email.message ?? '')}</p>
          )}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="company-phone">{t.fields.phone}</Label>
          <Input id="company-phone" {...form.register('phone')} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="company-website">{t.fields.website}</Label>
          <Input id="company-website" {...form.register('website')} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="company-industry">{t.fields.industry}</Label>
          <Input id="company-industry" {...form.register('industry')} />
        </div>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {tc.actions.cancel}
        </Button>
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {isEdit ? tc.actions.save : tc.actions.create}
        </Button>
      </DialogFooter>
    </form>
  );
}

function PersonForm({
  person,
  onDone,
  onCancel,
}: {
  person?: Person;
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = getTranslations('commerce').module;
  const tc = getTranslations('common');
  const isEdit = !!person;
  const create = useCreatePerson();
  const update = useUpdatePerson();

  const form = useForm<PersonValues>({
    resolver: zodResolver(createPersonSchema),
    defaultValues: person
      ? {
          firstName: person.firstName ?? undefined,
          lastName: person.lastName ?? undefined,
          email: person.email ?? undefined,
          directPhone: person.directPhone ?? undefined,
          title: person.title ?? undefined,
        }
      : { firstName: '', lastName: '' },
  });

  const onSubmit = async (values: PersonValues) => {
    try {
      const parsed = createPersonSchema.parse(values) as CreatePersonInput;
      if (isEdit && person) {
        await update.mutateAsync({ id: person.id, data: parsed });
        toast.success(t.customers.toastUpdated);
      } else {
        await create.mutateAsync(parsed);
        toast.success(t.customers.toastCreated);
      }
      onDone();
      form.reset();
    } catch (err) {
      toast.error((err as Error).message || t.common.saveFailed);
    }
  };

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="person-first">{t.customers.firstName}</Label>
          <Input id="person-first" {...form.register('firstName')} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="person-last">{t.customers.lastName}</Label>
          <Input id="person-last" {...form.register('lastName')} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="person-email">{t.fields.email}</Label>
          <Input id="person-email" type="email" {...form.register('email')} />
          {form.formState.errors.email && (
            <p className="text-xs text-destructive">{String(form.formState.errors.email.message ?? '')}</p>
          )}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="person-phone">{t.fields.phone}</Label>
          <Input id="person-phone" {...form.register('directPhone')} />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="person-title">{t.customers.jobTitle}</Label>
        <Input id="person-title" {...form.register('title')} />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {tc.actions.cancel}
        </Button>
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {isEdit ? tc.actions.save : tc.actions.create}
        </Button>
      </DialogFooter>
    </form>
  );
}
