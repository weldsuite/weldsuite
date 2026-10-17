/**
 * Quick-add a customer or supplier: the same small popup as WeldCRM's
 * "Add company" / "Add person" (type tabs on top, the fields that matter,
 * Cancel / Save). Everything else (addresses, banking, vendor tax) is filled
 * in later from the contact's panel. The full form at `/weldbooks/customers/add`
 * stays for deep links.
 */

import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Building2, User } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { PageTabs } from '@weldsuite/ui/components/page-tabs';
import { useI18n } from '@/lib/i18n/provider';
import type { ContactPayload } from './contact-form';
import { PersonEmailConflictDialog } from './person-email-conflict-dialog';
import { useCreateContact } from './use-create-contact';

type Kind = 'company' | 'person';

const optional = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

interface QuickAddContactDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  role: 'customer' | 'supplier';
  /** The new contact's id, once it is saved. */
  onCreated: (contactId: string | null) => void;
  /** The "already in the books" toast opens the existing contact. */
  onOpenExisting: (contactId: string) => void;
}

function QuickAddContactForm({
  role,
  onCreated,
  onOpenExisting,
  onCancel,
}: Readonly<
  Omit<QuickAddContactDialogProps, 'open' | 'onOpenChange'> & {
    onCancel: () => void;
  }
>) {
  const { t } = useI18n();
  const tc = t.accounting.contacts;
  const { submit, conflict, clearConflict, isPending } = useCreateContact({
    onCreated,
    onOpenExisting,
  });

  const schema = useMemo(
    () =>
      z
        .object({
          kind: z.enum(['company', 'person']),
          companyName: z.string().optional(),
          firstName: z.string().optional(),
          lastName: z.string().optional(),
          email: z.string().email().optional().or(z.literal('')),
          phone: z.string().optional(),
          vatNumber: z.string().optional(),
        })
        .superRefine((values, ctx) => {
          if (values.kind === 'company' && !values.companyName?.trim()) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['companyName'],
              message: tc.companyNameRequired,
            });
          }
          if (values.kind === 'person' && !values.firstName?.trim() && !values.lastName?.trim()) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['firstName'],
              message: tc.personNameRequired,
            });
          }
        }),
    [tc.companyNameRequired, tc.personNameRequired],
  );
  type Values = z.infer<typeof schema>;

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      kind: 'company',
      companyName: '',
      firstName: '',
      lastName: '',
      email: '',
      phone: '',
      vatNumber: '',
    },
  });
  const { errors } = form.formState;
  const kind = form.watch('kind');

  const onSubmit = (values: Values) => {
    const { kind } = values;
    const names: Partial<ContactPayload> & { name: string } =
      kind === 'company'
        ? {
            name: values.companyName?.trim() ?? '',
            companyName: values.companyName?.trim(),
            vatNumber: optional(values.vatNumber),
          }
        : {
            name: [values.firstName, values.lastName]
              .map((v) => v?.trim())
              .filter(Boolean)
              .join(' '),
            firstName: optional(values.firstName),
            lastName: optional(values.lastName),
          };
    const payload: ContactPayload = {
      role,
      kind,
      ...names,
      email: optional(values.email),
      phone: optional(values.phone),
    };
    void submit(payload);
  };

  return (
    <>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <PageTabs
          tabs={[
            { id: 'company', label: tc.kinds.company, icon: Building2 },
            { id: 'person', label: tc.kinds.person, icon: User },
          ]}
          activeTab={kind}
          onTabChange={(id) => {
            form.setValue('kind', id as Kind);
            form.clearErrors();
          }}
          className="mb-5"
        />

        {kind === 'company' ? (
          <div className="space-y-2">
            <Label htmlFor="quick-contact-company">{tc.companyName} *</Label>
            <Input id="quick-contact-company" autoFocus {...form.register('companyName')} />
            {errors.companyName ? <p className="text-xs text-destructive">{errors.companyName.message}</p> : null}
          </div>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="quick-contact-first">{tc.firstName}</Label>
                <Input id="quick-contact-first" autoFocus {...form.register('firstName')} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="quick-contact-last">{tc.lastName}</Label>
                <Input id="quick-contact-last" {...form.register('lastName')} />
              </div>
            </div>
            {errors.firstName ? <p className="text-xs text-destructive">{errors.firstName.message}</p> : null}
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="quick-contact-email">{tc.email}</Label>
          <Input id="quick-contact-email" type="email" {...form.register('email')} />
          {errors.email ? <p className="text-xs text-destructive">{errors.email.message}</p> : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="quick-contact-phone">{tc.phone}</Label>
          <Input id="quick-contact-phone" type="tel" {...form.register('phone')} />
        </div>

        {kind === 'company' ? (
          <div className="space-y-2">
            <Label htmlFor="quick-contact-vat">{tc.btwNumber}</Label>
            <Input id="quick-contact-vat" placeholder={tc.taxIdPlaceholder} {...form.register('vatNumber')} />
          </div>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
            {tc.cancel}
          </Button>
          <Button type="submit" disabled={isPending}>
            {isPending ? tc.creating : tc.createContact}
          </Button>
        </DialogFooter>
      </form>

      <PersonEmailConflictDialog
        person={conflict?.person ?? null}
        isPending={isPending}
        onLink={(person) => conflict && void submit(conflict.payload, { linkPersonId: person.id })}
        onCreateSeparate={() => conflict && void submit(conflict.payload, { createSeparatePerson: true })}
        onCancel={clearConflict}
      />
    </>
  );
}

export function QuickAddContactDialog({
  open,
  onOpenChange,
  role,
  onCreated,
  onOpenExisting,
}: Readonly<QuickAddContactDialogProps>) {
  const { t } = useI18n();
  const tc = t.accounting.contacts;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[38rem] max-h-[90vh] overflow-y-auto" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{role === 'supplier' ? tc.addSupplierTitle : tc.addCustomerTitle}</DialogTitle>
        </DialogHeader>

        {open ? (
          <QuickAddContactForm
            role={role}
            onCreated={(contactId) => {
              onOpenChange(false);
              onCreated(contactId);
            }}
            onOpenExisting={(contactId) => {
              onOpenChange(false);
              onOpenExisting(contactId);
            }}
            onCancel={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
