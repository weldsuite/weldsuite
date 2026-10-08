import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { toast } from 'sonner';
import { AlertCircle, ArrowLeft, Wand2 } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { PageLoader } from '@/components/page-loader';
import {
  useAccountingAccounts,
  useTaxLineCatalog,
  useUpdateAccount,
} from '@/hooks/queries/use-accounting-queries';
import type { Account, TaxLineCatalog } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { groupTaxLines, taxLineName } from '@/lib/weldbooks/tax-lines';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import { RemapTaxLinesDialog } from '@/app/weldbooks/entities/components/remap-tax-lines-dialog';
import { TaxLineSelect, useTaxSectionLabel } from '../components/tax-line-select';

function isIncomeOrExpense(account: Pick<Account, 'type'>): boolean {
  return account.type === 'revenue' || account.type === 'expense';
}

interface AccountRowProps {
  account: Account;
  catalog: TaxLineCatalog | undefined;
  disabled: boolean;
  onChange: (account: Account, code: string) => void;
}

function MappingAccountRow({ account, catalog, disabled, onChange }: Readonly<AccountRowProps>) {
  const { t } = useI18n();
  const tm = t.weldbooksUs.setup.mapping;
  const accountLabel = `${account.code} ${account.name}`;
  return (
    <li className="flex flex-col gap-2 border-t py-2 first:border-t-0 sm:flex-row sm:items-center sm:justify-between">
      <Link
        to="/weldbooks/accounts/$id"
        params={{ id: account.id }}
        className="min-w-0 truncate text-sm hover:underline"
      >
        <span className="mr-2 font-mono text-xs text-muted-foreground">{account.code}</span>
        {account.name}
        <span className="ml-2 text-xs capitalize text-muted-foreground">{account.type}</span>
      </Link>
      <div className="w-full sm:w-72">
        <TaxLineSelect
          compact
          aria-label={`${tm.reassign}: ${accountLabel}`}
          value={account.taxLine ?? ''}
          catalog={catalog}
          disabled={disabled}
          onChange={(code) => onChange(account, code)}
        />
      </div>
    </li>
  );
}

/**
 * Tax line mapping (US): every line of the entity's income-tax return with the
 * accounts that report on it, and the accounts that still have no line.
 * Reassign an account in place.
 */
export default function TaxLineMappingPage() {
  const { t } = useI18n();
  const tm = t.weldbooksUs.setup.mapping;
  const { code: jurisdictionCode, entity, isResolved } = useCurrentJurisdiction();
  const isUs = jurisdictionCode === 'US';
  const canUpdateAccounts = useCan('accounts:update');
  const catalogQuery = useTaxLineCatalog(undefined, { enabled: isUs });
  const accountsQuery = useAccountingAccounts(undefined, { enabled: isUs });
  const updateAccount = useUpdateAccount();
  const sectionLabel = useTaxSectionLabel();
  const [showEmpty, setShowEmpty] = useState(false);
  const [remapOpen, setRemapOpen] = useState(false);

  const catalog = catalogQuery.data;
  const accounts = useMemo(
    () => (accountsQuery.data?.data ?? []).filter((a) => a.isActive !== false),
    [accountsQuery.data],
  );

  const { byLine, needsLine } = useMemo(() => {
    const known = new Set(catalog?.lines.map((l) => l.code));
    const mapped = new Map<string, Account[]>();
    const unmapped: Account[] = [];
    for (const account of accounts) {
      if (account.taxLine && known.has(account.taxLine)) {
        mapped.set(account.taxLine, [...(mapped.get(account.taxLine) ?? []), account]);
      } else if (account.taxLine || isIncomeOrExpense(account)) {
        // No line, or a line of another return: both need a decision.
        unmapped.push(account);
      }
    }
    return { byLine: mapped, needsLine: unmapped };
  }, [accounts, catalog]);

  const groups = useMemo(() => groupTaxLines(catalog), [catalog]);

  const reassign = async (account: Account, code: string) => {
    try {
      await updateAccount.mutateAsync({ id: account.id, data: { taxLine: code || null } });
      toast.success(tm.saved);
    } catch (err) {
      toast.error(tm.saveFailed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  if (!isResolved) return <PageLoader fullScreen={false} />;

  const header = (
    <div className="flex items-start gap-3">
      <Link to="/weldbooks/accounts">
        <Button variant="ghost" size="icon" aria-label={tm.back}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
      </Link>
      <div className="min-w-0 flex-1">
        <h1 className="text-2xl font-semibold">{tm.title}</h1>
        {catalog ? (
          <p className="text-sm text-muted-foreground">
            {tm.description.replace('{form}', catalog.formLabel).replace('{year}', String(catalog.taxYear))}
          </p>
        ) : null}
      </div>
      {isUs && catalog && entity && canUpdateAccounts ? (
        <Button variant="outline" size="sm" onClick={() => setRemapOpen(true)}>
          <Wand2 className="mr-1 h-4 w-4" aria-hidden />
          {tm.applyDefaults}
        </Button>
      ) : null}
    </div>
  );

  if (!isUs) {
    return (
      <div className="space-y-6 p-4 sm:p-6">
        {header}
        <p className="text-sm text-muted-foreground">{tm.usOnly}</p>
      </div>
    );
  }

  if (catalogQuery.isLoading || accountsQuery.isLoading) return <PageLoader fullScreen={false} />;

  if (catalogQuery.isError || accountsQuery.isError || !catalog) {
    return (
      <div className="space-y-6 p-4 sm:p-6">
        {header}
        <div className="flex flex-col items-center gap-3 p-8 text-center">
          <AlertCircle className="h-8 w-8 text-destructive" aria-hidden />
          <p className="text-sm text-muted-foreground">{tm.loadError}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void catalogQuery.refetch();
              void accountsQuery.refetch();
            }}
          >
            {tm.retry}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {header}

      {!canUpdateAccounts ? (
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">{tm.noPermission}</p>
      ) : null}

      <Card className={needsLine.length > 0 ? 'border-amber-500/50' : undefined}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            {tm.unmappedTitle}
            {needsLine.length > 0 ? <Badge variant="secondary">{needsLine.length}</Badge> : null}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {needsLine.length === 0 ? (
            <p className="text-sm text-muted-foreground">{tm.unmappedEmpty}</p>
          ) : (
            <ul>
              {needsLine.map((account) => (
                <MappingAccountRow
                  key={account.id}
                  account={account}
                  catalog={catalog}
                  disabled={!canUpdateAccounts || updateAccount.isPending}
                  onChange={reassign}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={showEmpty} onCheckedChange={(checked) => setShowEmpty(checked === true)} />
        {tm.showEmptyLines}
      </label>

      {groups.map((group) => {
        const lines = group.lines.filter((line) => showEmpty || (byLine.get(line.code)?.length ?? 0) > 0);
        if (lines.length === 0) return null;
        return (
          <section key={group.key} aria-labelledby={`section-${group.key}`} className="space-y-2">
            <h2 id={`section-${group.key}`} className="text-sm font-semibold text-muted-foreground">
              {sectionLabel(group.key, group.label)}
            </h2>
            <Card>
              <CardContent className="divide-y p-0">
                {lines.map((line) => {
                  const members = byLine.get(line.code) ?? [];
                  return (
                    <div key={line.code} className="px-4 py-3">
                      <div className="flex items-baseline justify-between gap-3">
                        <h3 className="text-sm font-medium">{taxLineName(line)}</h3>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {members.length === 1
                            ? tm.accountsCountOne
                            : tm.accountsCount.replace('{count}', String(members.length))}
                        </span>
                      </div>
                      {members.length === 0 ? (
                        <p className="mt-1 text-xs text-muted-foreground">{tm.lineEmpty}</p>
                      ) : (
                        <ul className="mt-1">
                          {members.map((account) => (
                            <MappingAccountRow
                              key={account.id}
                              account={account}
                              catalog={catalog}
                              disabled={!canUpdateAccounts || updateAccount.isPending}
                              onChange={reassign}
                            />
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          </section>
        );
      })}

      {entity ? (
        <RemapTaxLinesDialog
          mode="defaults"
          entityId={entity.id}
          formLabel={catalog.formLabel}
          open={remapOpen}
          onOpenChange={setRemapOpen}
        />
      ) : null}
    </div>
  );
}
