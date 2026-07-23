import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate, Link } from '@tanstack/react-router';
import { useTranslations } from '@weldsuite/i18n/client';
import { useCreateAccountingCustomer } from '@/hooks/queries/use-accounting-queries';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@weldsuite/ui/components/card';
import { ArrowLeft } from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';

function createContactSchema(st: (key: string) => string) {
  return z.object({
    role: z.enum(['customer', 'supplier', 'both']),
    name: z.string().min(1, st('sweep.weldbooks.contactForm.nameRequired')),
    companyName: z.string().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    email: z.string().email(st('sweep.weldbooks.contactForm.invalidEmail')).optional().or(z.literal('')),
    phone: z.string().optional(),
    taxNumber: z.string().optional(),
    kvkNumber: z.string().optional(),
    iban: z.string().optional(),
    bic: z.string().optional(),
    paymentTermsDays: z.coerce.number().int().min(0).optional(),
    notes: z.string().optional(),
  });
}

type ContactFormValues = z.infer<ReturnType<typeof createContactSchema>>;

export default function AddContactPage() {
  const navigate = useNavigate();
  const createContact = useCreateAccountingCustomer();
  const { t } = useI18n();
  const st = useTranslations();
  const tc = t.accounting.contacts;
  const contactSchema = useMemo(() => createContactSchema(st), [st]);

  const form = useForm<ContactFormValues>({
    resolver: zodResolver(contactSchema),
    defaultValues: {
      role: 'customer',
      name: '',
      companyName: '',
      firstName: '',
      lastName: '',
      email: '',
      phone: '',
      taxNumber: '',
      kvkNumber: '',
      iban: '',
      bic: '',
      paymentTermsDays: 30,
      notes: '',
    },
  });

  const onSubmit = async (values: ContactFormValues) => {
    await createContact.mutateAsync(values as Record<string, unknown>);
    navigate({ to: '/weldbooks/customers' });
  };

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div className="flex items-center gap-4">
        <Link to="/weldbooks/customers">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <h1 className="text-2xl font-semibold">{tc.newContact}</h1>
      </div>

      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>{tc.general}</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <Label htmlFor="role">{tc.role}</Label>
              <Select
                value={form.watch('role')}
                onValueChange={(v) =>
                  form.setValue('role', v as ContactFormValues['role'])
                }
              >
                <SelectTrigger id="role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="customer">{tc.roles.customer}</SelectItem>
                  <SelectItem value="supplier">{tc.roles.supplier}</SelectItem>
                  <SelectItem value="both">{tc.roles.both}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2">
              <Label htmlFor="name">{tc.name} *</Label>
              <Input id="name" {...form.register('name')} />
              {form.formState.errors.name && (
                <p className="text-sm text-destructive mt-1">{form.formState.errors.name.message}</p>
              )}
            </div>
            <div>
              <Label htmlFor="firstName">{tc.firstName}</Label>
              <Input id="firstName" {...form.register('firstName')} />
            </div>
            <div>
              <Label htmlFor="lastName">{tc.lastName}</Label>
              <Input id="lastName" {...form.register('lastName')} />
            </div>
            <div className="col-span-2">
              <Label htmlFor="companyName">{tc.companyName}</Label>
              <Input id="companyName" {...form.register('companyName')} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{tc.contactDetails}</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="email">{tc.email}</Label>
              <Input id="email" type="email" {...form.register('email')} />
              {form.formState.errors.email && (
                <p className="text-sm text-destructive mt-1">{form.formState.errors.email.message}</p>
              )}
            </div>
            <div>
              <Label htmlFor="phone">{tc.phone}</Label>
              <Input id="phone" {...form.register('phone')} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{tc.taxAndRegistration}</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="taxNumber">{tc.btwNumber}</Label>
              <Input id="taxNumber" placeholder="NL000000000B01" {...form.register('taxNumber')} />
            </div>
            <div>
              <Label htmlFor="kvkNumber">{tc.kvkNumber}</Label>
              <Input id="kvkNumber" {...form.register('kvkNumber')} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{tc.bankingSection}</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="iban">{tc.iban}</Label>
              <Input id="iban" {...form.register('iban')} />
            </div>
            <div>
              <Label htmlFor="bic">{tc.bic}</Label>
              <Input id="bic" {...form.register('bic')} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{tc.payment}</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="paymentTermsDays">{tc.paymentTermsDays}</Label>
              <Input id="paymentTermsDays" type="number" {...form.register('paymentTermsDays')} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{tc.notes}</CardTitle>
          </CardHeader>
          <CardContent>
            <Textarea id="notes" rows={4} {...form.register('notes')} />
          </CardContent>
        </Card>

        <div className="flex justify-end gap-3">
          <Link to="/weldbooks/customers">
            <Button type="button" variant="outline">{tc.cancel}</Button>
          </Link>
          <Button type="submit" disabled={createContact.isPending}>
            {createContact.isPending ? tc.creating : tc.createContact}
          </Button>
        </div>
      </form>
    </div>
  );
}
