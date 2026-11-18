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
import { FieldError } from '@weldsuite/ui/components/field';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Tabs, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';
import { commerceSchemaOptions } from '../../lib/form';
import type { CustomerKind, CustomerRow } from '../config/customer-row';

type CompanyValues = z.input<typeof createCompanySchema>;
type PersonValues = z.input<typeof createPersonSchema>;

/**
 * A person needs something to be known by: with every field blank the API
 * saves one called "Unnamed", which then shows up in WeldCRM too.
 */
const personFormSchema = createPersonSchema.superRefine((person, ctx) => {
  const named = [person.firstName, person.lastName, person.email].some((v) => (v ?? '').trim() !== '');
  if (!named) ctx.addIssue({ code: 'custom', path: ['firstName'] });
});

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
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customer?: CustomerRow;
}>) {
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
}: Readonly<{
  company?: Company;
  onDone: () => void;
  onCancel: () => void;
}>) {
  const t = getTranslations('commerce').module;
  const tc = getTranslations('common');
  const isEdit = !!company;
  const create = useCreateCompany();
  const update = useUpdateCompany();

  const form = useForm<CompanyValues>({
    resolver: zodResolver(createCompanySchema, commerceSchemaOptions()),
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
  const { errors } = form.formState;

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
    <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-3" noValidate>
      <div className="grid gap-1.5">
        <Label htmlFor="company-name">{t.fields.name}</Label>
        <Input id="company-name" aria-invalid={!!errors.name || undefined} {...form.register('name')} />
        <FieldError className="text-xs" errors={[errors.name]} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="company-email">{t.fields.email}</Label>
          <Input id="company-email" type="email" aria-invalid={!!errors.email || undefined} {...form.register('email')} />
          <FieldError className="text-xs" errors={[errors.email]} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="company-phone">{t.fields.phone}</Label>
          <Input id="company-phone" aria-invalid={!!errors.phone || undefined} {...form.register('phone')} />
          <FieldError className="text-xs" errors={[errors.phone]} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="company-website">{t.fields.website}</Label>
          <Input id="company-website" aria-invalid={!!errors.website || undefined} {...form.register('website')} />
          {/* The schema's website check carries its own English message; say it in the UI language. */}
          <FieldError className="text-xs">
            {errors.website?.type === 'custom' ? t.validation.invalidWebsite : errors.website?.message}
          </FieldError>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="company-industry">{t.fields.industry}</Label>
          <Input id="company-industry" aria-invalid={!!errors.industry || undefined} {...form.register('industry')} />
          <FieldError className="text-xs" errors={[errors.industry]} />
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
}: Readonly<{
  person?: Person;
  onDone: () => void;
  onCancel: () => void;
}>) {
  const t = getTranslations('commerce').module;
  const tc = getTranslations('common');
  const isEdit = !!person;
  const create = useCreatePerson();
  const update = useUpdatePerson();

  const form = useForm<PersonValues>({
    resolver: zodResolver(personFormSchema, commerceSchemaOptions()),
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
  const { errors } = form.formState;

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
    <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-3" noValidate>
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="person-first">{t.customers.firstName}</Label>
          <Input id="person-first" aria-invalid={!!errors.firstName || undefined} {...form.register('firstName')} />
          <FieldError className="text-xs">
            {errors.firstName?.type === 'custom' ? t.validation.nameOrEmail : errors.firstName?.message}
          </FieldError>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="person-last">{t.customers.lastName}</Label>
          <Input id="person-last" aria-invalid={!!errors.lastName || undefined} {...form.register('lastName')} />
          <FieldError className="text-xs" errors={[errors.lastName]} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="person-email">{t.fields.email}</Label>
          <Input id="person-email" type="email" aria-invalid={!!errors.email || undefined} {...form.register('email')} />
          <FieldError className="text-xs" errors={[errors.email]} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="person-phone">{t.fields.phone}</Label>
          <Input id="person-phone" aria-invalid={!!errors.directPhone || undefined} {...form.register('directPhone')} />
          <FieldError className="text-xs" errors={[errors.directPhone]} />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="person-title">{t.customers.jobTitle}</Label>
        <Input id="person-title" aria-invalid={!!errors.title || undefined} {...form.register('title')} />
        <FieldError className="text-xs" errors={[errors.title]} />
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
