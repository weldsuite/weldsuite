import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { ErrorBanner } from '@weldsuite/ui/components/error-banner';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useAccountingAccounts } from '@/hooks/queries/use-accounting-queries';
import { useDifferenceSettings, useUpdateDifferenceSettings } from '@/hooks/queries/use-weldbooks-processing-queries';
import type { Account } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';

const DEFAULT_ACCOUNT = '__default__';

/** The rounding limit as the API wants it (`"1.00"`), or null when the text is not an amount of zero or more. */
export function normalizeCap(text: string): string | null {
  const trimmed = text.trim().replace(/\s/g, '');
  if (!/^\d+([.,]\d{1,2})?$/.test(trimmed)) return null;
  const [whole = '0', fraction = ''] = trimmed.replace(',', '.').split('.');
  return `${Number(whole)}.${fraction.padEnd(2, '0')}`;
}

function AccountSelect({
  id,
  value,
  onChange,
  accounts,
  defaultLabel,
  disabled,
  describedBy,
}: Readonly<{
  id: string;
  value: string;
  onChange: (value: string) => void;
  accounts: readonly Account[];
  defaultLabel: string;
  disabled: boolean;
  describedBy: string;
}>) {
  return (
    <Select
      value={value || DEFAULT_ACCOUNT}
      // Radix reports an empty value when the chosen account is not among its options yet (accounts still
      // loading): that is not a choice, and must not clear the saved account.
      onValueChange={(next) => next && onChange(next === DEFAULT_ACCOUNT ? '' : next)}
      disabled={disabled}
    >
      <SelectTrigger id={id} aria-describedby={describedBy} className="w-full sm:max-w-sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT_ACCOUNT}>{defaultLabel}</SelectItem>
        {accounts.map((account) => (
          <SelectItem key={account.id} value={account.id}>
            {account.code} — {account.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Payment differences of the entity (shown only where the edition has `books-bank-processing`): the
 * accounts bank costs, payment discount and rounding go to, and the rounding
 * limit. A gap up to the limit is booked to rounding on its own; a larger one
 * always asks.
 */
export function DifferencesCard() {
  const { t } = useI18n();
  const td = t.weldbooksConnected.differences;
  const ids = useId();
  const canUpdate = useCan('accounts:update');
  const settings = useDifferenceSettings();
  const update = useUpdateDifferenceSettings();
  const { data: accountsData } = useAccountingAccounts();

  const accounts = useMemo(
    () =>
      ((accountsData?.data ?? []) as Account[])
        .filter((account) => account.isActive !== false && (account.type === 'expense' || account.type === 'revenue'))
        .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })),
    [accountsData],
  );

  const [bankCosts, setBankCosts] = useState('');
  const [discount, setDiscount] = useState('');
  const [rounding, setRounding] = useState('');
  const [cap, setCap] = useState('');
  const [capTouched, setCapTouched] = useState(false);

  const data = settings.data;
  useEffect(() => {
    if (!data) return;
    setBankCosts(data.bankCostsAccountId ?? '');
    setDiscount(data.paymentDiscountAccountId ?? '');
    setRounding(data.roundingAccountId ?? '');
    setCap(data.roundingCap);
    setCapTouched(false);
  }, [data]);

  const capValue = normalizeCap(cap);
  const capInvalid = capTouched && capValue === null;
  const capErrorId = `${ids}-cap-error`;
  const capDescribedBy = capInvalid ? `${ids}-cap-help ${capErrorId}` : `${ids}-cap-help`;
  const defaultRounding = accounts.find((account) => account.id === data?.effectiveRoundingAccountId);
  const roundingDefaultLabel = defaultRounding
    ? td.currentDefault.replace('{name}', `${defaultRounding.code} — ${defaultRounding.name}`)
    : td.defaultOption;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setCapTouched(true);
    if (capValue === null || !canUpdate) return;
    update.mutate(
      {
        bankCostsAccountId: bankCosts || null,
        paymentDiscountAccountId: discount || null,
        roundingAccountId: rounding || null,
        roundingCap: capValue,
      },
      {
        onSuccess: () => toast.success(td.saved),
        onError: (error) => toast.error(td.saveFailed, { description: error instanceof Error ? error.message : undefined }),
      },
    );
  };

  return (
    <Card data-testid="differences-card">
      <CardHeader>
        <CardTitle>{td.title}</CardTitle>
        <CardDescription>{td.description}</CardDescription>
      </CardHeader>
      <CardContent>
        {settings.isLoading ? <PageLoader fullScreen={false} /> : null}
        {settings.isError ? <ErrorBanner error={td.loadFailed} /> : null}
        {data ? (
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor={`${ids}-bank-costs`}>{td.bankCosts}</Label>
              <AccountSelect
                id={`${ids}-bank-costs`}
                value={bankCosts}
                onChange={setBankCosts}
                accounts={accounts}
                defaultLabel={td.defaultOption}
                disabled={!canUpdate}
                describedBy={`${ids}-bank-costs-help`}
              />
              <p id={`${ids}-bank-costs-help`} className="text-xs text-muted-foreground">
                {td.bankCostsHelp}
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${ids}-discount`}>{td.paymentDiscount}</Label>
              <AccountSelect
                id={`${ids}-discount`}
                value={discount}
                onChange={setDiscount}
                accounts={accounts}
                defaultLabel={td.defaultOption}
                disabled={!canUpdate}
                describedBy={`${ids}-discount-help`}
              />
              <p id={`${ids}-discount-help`} className="text-xs text-muted-foreground">
                {td.paymentDiscountHelp}
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${ids}-rounding`}>{td.rounding}</Label>
              <AccountSelect
                id={`${ids}-rounding`}
                value={rounding}
                onChange={setRounding}
                accounts={accounts}
                defaultLabel={roundingDefaultLabel}
                disabled={!canUpdate}
                describedBy={`${ids}-rounding-help`}
              />
              <p id={`${ids}-rounding-help`} className="text-xs text-muted-foreground">
                {td.roundingHelp}
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${ids}-cap`}>{td.roundingCap}</Label>
              <Input
                id={`${ids}-cap`}
                inputMode="decimal"
                autoComplete="off"
                className="max-w-[160px] tabular-nums"
                value={cap}
                disabled={!canUpdate}
                aria-invalid={capInvalid || undefined}
                aria-describedby={capDescribedBy}
                onChange={(event) => setCap(event.target.value)}
                onBlur={() => setCapTouched(true)}
              />
              <p id={`${ids}-cap-help`} className="text-xs text-muted-foreground">
                {td.roundingCapHelp}
              </p>
              {capInvalid ? (
                <p id={`${ids}-cap-error`} className="text-xs text-destructive" role="alert">
                  {td.invalidCap}
                </p>
              ) : null}
            </div>
            {canUpdate ? (
              <Button type="submit" disabled={update.isPending}>
                {update.isPending ? td.saving : td.save}
              </Button>
            ) : null}
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}
