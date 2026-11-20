import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useParams, useNavigate, Link } from '@tanstack/react-router';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  useAccountingAccount,
  useUpdateAccount,
} from '@/hooks/queries/use-accounting-queries';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
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
import { toast } from 'sonner';
import { useDescribeError } from '@/app/weldbooks/invoices/components/sales-tax-error-notice';
import { useI18n } from '@/lib/i18n/provider';
import { useCurrentEntityCurrency } from '@/hooks/use-current-entity-currency';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import type { Account } from '@/lib/api/domains/weldbooks';
import { TaxReportingCard } from '../../components/tax-reporting-card';
import {
  ACCOUNT_TYPES,
  createAccountSchema,
  normalSideOf,
  openingBalancePayload,
  subtypesByType,
  type AccountFormValues,
} from '../../components/account-form-schema';

export default function EditAccountPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { data, isLoading } = useAccountingAccount(id);
  const { t } = useI18n();

  const account = data?.data;

  if (isLoading) return <PageLoader fullScreen={false} />;

  if (!account) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">{t.accounting.accounts.notFound}</p>
      </div>
    );
  }

  // The form starts from the loaded account, so its selects are filled from the first render.
  return <EditAccountForm key={account.id} id={id} account={account} />;
}

/** The form's values for a stored account. */
function accountFormValues(account: Account, entityCurrency: string | null | undefined): AccountFormValues {
  const type = (ACCOUNT_TYPES as readonly string[]).includes(account.type)
    ? (account.type as AccountFormValues['type'])
    : 'asset';
  const normalSide =
    account.normalSide === 'debit' || account.normalSide === 'credit' ? account.normalSide : normalSideOf(type);
  return {
    code: account.code ?? '',
    name: account.name ?? '',
    description: account.description ?? '',
    type,
    subtype: account.subtype ?? '',
    normalSide,
    currency: account.currency ?? entityCurrency ?? '',
    openingBalance: Number(account.openingBalance ?? 0),
    isActive: account.isActive ?? true,
    taxLine: account.taxLine ?? '',
    form1099Box: account.form1099Box ?? '',
  };
}

function EditAccountForm({ id, account }: Readonly<{ id: string; account: Account }>) {
  const navigate = useNavigate();
  const updateAccount = useUpdateAccount();
  const { t } = useI18n();
  const st = useTranslations();
  const ta = t.accounting.accounts;
  const describeError = useDescribeError();
  const { entityCurrency } = useCurrentEntityCurrency();
  const { code: jurisdictionCode, features } = useCurrentJurisdiction();
  const isUs = jurisdictionCode === 'US';
  const accountSchema = useMemo(() => createAccountSchema(st), [st]);

  const form = useForm({
    resolver: zodResolver(accountSchema),
    defaultValues: accountFormValues(account, entityCurrency),
  });

  const selectedType = form.watch('type');
  const subtypes = subtypesByType[selectedType] ?? [];
  const errors = form.formState.errors;

  const onSubmit = async (values: AccountFormValues) => {
    // The tax line and the 1099 box exist for US entities only; an empty one clears the stored one.
    const { taxLine, form1099Box, code, type, normalSide, ...rest } = values;
    // Code, type and normal side go along only when they changed: a system account refuses them even unchanged.
    // An empty currency is left out so the stored one is kept.
    try {
      await updateAccount.mutateAsync({
        id,
        data: {
          ...rest,
          ...(code === account.code ? {} : { code }),
          ...(type === account.type ? {} : { type }),
          ...(normalSide === account.normalSide ? {} : { normalSide }),
          openingBalance: openingBalancePayload(values.openingBalance),
          currency: values.currency || undefined,
          ...(isUs ? { taxLine: taxLine || null, ...(features.form1099 ? { form1099Box: form1099Box || null } : {}) } : {}),
        } as Record<string, unknown>,
      });
    } catch (err) {
      toast.error(ta.updateFailed, { description: describeError(err) });
      return;
    }
    navigate({ to: '/weldbooks/accounts/$id', params: { id } });
  };

  // A refused form says so; the fields show why.
  const onInvalid = () => {
    toast.error(ta.updateFailed, { description: st('sweep.weldbooks.accountForm.checkFields') });
  };

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div className="flex items-center gap-4">
        <Button asChild variant="ghost" size="icon">
          <Link to="/weldbooks/accounts/$id" params={{ id }} aria-label={ta.backToAccounts}>
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold">{ta.editAccount}</h1>
      </div>

      <form onSubmit={form.handleSubmit(onSubmit, onInvalid)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>{ta.accountDetails}</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="code">{ta.summaryCode} *</Label>
              <Input id="code" placeholder={ta.codePlaceholder} {...form.register('code')} />
              {errors.code && (
                <p className="text-sm text-destructive mt-1">{errors.code.message}</p>
              )}
            </div>
            <div>
              <Label htmlFor="name">{ta.summaryName} *</Label>
              <Input id="name" {...form.register('name')} />
              {errors.name && (
                <p className="text-sm text-destructive mt-1">{errors.name.message}</p>
              )}
            </div>
            <div className="col-span-2">
              <Label htmlFor="description">{ta.description}</Label>
              <Textarea id="description" rows={2} {...form.register('description')} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{ta.classification}</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="type">{ta.summaryType} *</Label>
              <Select
                value={form.watch('type')}
                onValueChange={(v) => {
                  if (!v) return;
                  form.setValue('type', v as AccountFormValues['type'], { shouldDirty: true, shouldValidate: true });
                  form.setValue('subtype', '');
                  form.setValue('normalSide', normalSideOf(v), { shouldDirty: true, shouldValidate: true });
                }}
              >
                <SelectTrigger id="type" aria-invalid={errors.type ? true : undefined}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="asset">{ta.types.asset}</SelectItem>
                  <SelectItem value="liability">{ta.types.liability}</SelectItem>
                  <SelectItem value="equity">{ta.types.equity}</SelectItem>
                  <SelectItem value="revenue">{ta.types.revenue}</SelectItem>
                  <SelectItem value="expense">{ta.types.expense}</SelectItem>
                </SelectContent>
              </Select>
              {errors.type && (
                <p className="text-sm text-destructive mt-1">{errors.type.message}</p>
              )}
            </div>
            <div>
              <Label htmlFor="subtype">{ta.subtype}</Label>
              <Select
                value={form.watch('subtype') ?? ''}
                onValueChange={(v) => form.setValue('subtype', v, { shouldDirty: true })}
              >
                <SelectTrigger id="subtype">
                  <SelectValue placeholder={ta.selectSubtype} />
                </SelectTrigger>
                <SelectContent>
                  {subtypes.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {ta.subtypeLabels[s.labelKey as keyof typeof ta.subtypeLabels]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="normalSide">{ta.normalSide} *</Label>
              <Select
                value={form.watch('normalSide')}
                onValueChange={(v) => {
                  if (v) form.setValue('normalSide', v as AccountFormValues['normalSide'], { shouldDirty: true, shouldValidate: true });
                }}
              >
                <SelectTrigger id="normalSide" aria-invalid={errors.normalSide ? true : undefined}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="debit">{ta.debit}</SelectItem>
                  <SelectItem value="credit">{ta.credit}</SelectItem>
                </SelectContent>
              </Select>
              {errors.normalSide && (
                <p className="text-sm text-destructive mt-1">{errors.normalSide.message}</p>
              )}
            </div>
          </CardContent>
        </Card>

        {isUs && (
          <TaxReportingCard
            taxLine={form.watch('taxLine') ?? ''}
            form1099Box={form.watch('form1099Box') ?? ''}
            onTaxLineChange={(code) => form.setValue('taxLine', code, { shouldDirty: true })}
            onForm1099BoxChange={(code) => form.setValue('form1099Box', code, { shouldDirty: true })}
            showForm1099={features.form1099}
          />
        )}

        <Card>
          <CardHeader>
            <CardTitle>{ta.financial}</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="currency">{ta.currency}</Label>
              <Input id="currency" {...form.register('currency')} />
            </div>
            <div>
              <Label htmlFor="openingBalance">{ta.openingBalance}</Label>
              <Input id="openingBalance" type="number" step="0.01" {...form.register('openingBalance')} />
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-3">
          <Link to="/weldbooks/accounts/$id" params={{ id }}>
            <Button type="button" variant="outline">{ta.cancel}</Button>
          </Link>
          <Button type="submit" disabled={updateAccount.isPending}>
            {updateAccount.isPending ? ta.saving : ta.saveChanges}
          </Button>
        </div>
      </form>
    </div>
  );
}
