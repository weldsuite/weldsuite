import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useParams, useNavigate, Link } from '@tanstack/react-router';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  useAccountingAccount,
  useUpdateAccount,
} from '@/hooks/queries/use-accounting-queries';
import { PageLoader } from '@/components/page-loader';
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

const subtypesByType: Record<string, { value: string; labelKey: string }[]> = {
  asset: [
    { value: 'current_asset', labelKey: 'currentAsset' },
    { value: 'fixed_asset', labelKey: 'fixedAsset' },
    { value: 'bank', labelKey: 'bank' },
    { value: 'cash', labelKey: 'cash' },
    { value: 'accounts_receivable', labelKey: 'accountsReceivable' },
    { value: 'inventory', labelKey: 'inventory' },
    { value: 'prepaid_expense', labelKey: 'prepaidExpense' },
  ],
  liability: [
    { value: 'current_liability', labelKey: 'currentLiability' },
    { value: 'long_term_liability', labelKey: 'longTermLiability' },
    { value: 'accounts_payable', labelKey: 'accountsPayable' },
    { value: 'tax_payable', labelKey: 'taxPayable' },
    { value: 'credit_card', labelKey: 'creditCard' },
  ],
  equity: [
    { value: 'owners_equity', labelKey: 'ownersEquity' },
    { value: 'retained_earnings', labelKey: 'retainedEarnings' },
    { value: 'share_capital', labelKey: 'shareCapital' },
  ],
  revenue: [
    { value: 'sales', labelKey: 'sales' },
    { value: 'other_income', labelKey: 'otherIncome' },
    { value: 'interest_income', labelKey: 'interestIncome' },
    { value: 'service_revenue', labelKey: 'serviceRevenue' },
  ],
  expense: [
    { value: 'operating_expense', labelKey: 'operatingExpense' },
    { value: 'cost_of_goods_sold', labelKey: 'costOfGoodsSold' },
    { value: 'payroll', labelKey: 'payroll' },
    { value: 'depreciation', labelKey: 'depreciation' },
    { value: 'interest_expense', labelKey: 'interestExpense' },
    { value: 'tax_expense', labelKey: 'taxExpense' },
  ],
};

function createAccountSchema(st: (key: string) => string) {
  return z.object({
    code: z.string().min(1, st('sweep.weldbooks.accountForm.codeRequired')),
    name: z.string().min(1, st('sweep.weldbooks.accountForm.nameRequired')),
    description: z.string().optional(),
    type: z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']),
    subtype: z.string().optional(),
    normalSide: z.enum(['debit', 'credit']),
    currency: z.string().default('EUR'),
    openingBalance: z.coerce.number().optional(),
    isActive: z.boolean().optional(),
  });
}

type AccountFormValues = z.infer<ReturnType<typeof createAccountSchema>>;

export default function EditAccountPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const navigate = useNavigate();
  const { data, isLoading } = useAccountingAccount(id);
  const updateAccount = useUpdateAccount();
  const { t } = useI18n();
  const st = useTranslations();
  const ta = t.accounting.accounts;
  const accountSchema = useMemo(() => createAccountSchema(st), [st]);

  const account = data?.data;

  const form = useForm({
    resolver: zodResolver(accountSchema),
    values: account
      ? {
          code: account.code ?? '',
          name: account.name ?? '',
          description: account.description ?? '',
          type: (account.type as AccountFormValues['type']) ?? 'asset',
          subtype: account.subtype ?? '',
          normalSide: (account.normalSide as AccountFormValues['normalSide']) ?? 'debit',
          currency: account.currency ?? 'EUR',
          openingBalance: Number(account.openingBalance ?? 0),
          isActive: account.isActive ?? true,
        }
      : undefined,
  });

  const selectedType = form.watch('type');
  const subtypes = subtypesByType[selectedType] ?? [];

  if (isLoading) return <PageLoader fullScreen={false} />;

  if (!account) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">{ta.notFound}</p>
      </div>
    );
  }

  const onSubmit = async (values: any) => {
    await updateAccount.mutateAsync({ id, data: values as Record<string, unknown> });
    navigate({ to: `/weldbooks/accounts/${id}` as any });
  };

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div className="flex items-center gap-4">
        <Link to={`/weldbooks/accounts/${id}` as any}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <h1 className="text-2xl font-semibold">{ta.editAccount}</h1>
      </div>

      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>{ta.accountDetails}</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="code">{ta.summaryCode} *</Label>
              <Input id="code" placeholder={ta.codePlaceholder} {...form.register('code')} />
              {form.formState.errors.code && (
                <p className="text-sm text-destructive mt-1">{form.formState.errors.code.message}</p>
              )}
            </div>
            <div>
              <Label htmlFor="name">{ta.summaryName} *</Label>
              <Input id="name" {...form.register('name')} />
              {form.formState.errors.name && (
                <p className="text-sm text-destructive mt-1">{form.formState.errors.name.message}</p>
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
                  form.setValue('type', v as AccountFormValues['type']);
                  form.setValue('subtype', '');
                  if (v === 'asset' || v === 'expense') {
                    form.setValue('normalSide', 'debit');
                  } else {
                    form.setValue('normalSide', 'credit');
                  }
                }}
              >
                <SelectTrigger id="type">
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
            </div>
            <div>
              <Label htmlFor="subtype">{ta.subtype}</Label>
              <Select
                value={form.watch('subtype') ?? ''}
                onValueChange={(v) => form.setValue('subtype', v)}
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
                onValueChange={(v) => form.setValue('normalSide', v as AccountFormValues['normalSide'])}
              >
                <SelectTrigger id="normalSide">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="debit">{ta.debit}</SelectItem>
                  <SelectItem value="credit">{ta.credit}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

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
          <Link to={`/weldbooks/accounts/${id}` as any}>
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
