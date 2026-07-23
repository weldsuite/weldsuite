import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Landmark } from 'lucide-react';
import { useAccountingBankAccounts } from '@/hooks/queries/use-accounting-queries';
import { Badge } from '@weldsuite/ui/components/badge';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import { EmptyStateIllustration, type ColumnDef } from '@/components/entity-list';
import { BankAccountFormDialog } from '@/components/accounting/bank-account-form-dialog';
import type { BankAccount } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';

function formatBalance(value: string | null | undefined, currency: string | null | undefined): string {
  return new Intl.NumberFormat('nl-NL', {
    style: 'currency',
    currency: currency || 'EUR',
  }).format(Number(value ?? 0));
}

export default function BankAccountsPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const { data, isLoading } = useAccountingBankAccounts();
  const navigate = useNavigate();
  const { t } = useI18n();
  const tbp = t.accounting.bankingPages;

  const accounts = (data?.data ?? []) as BankAccount[];

  const columns: ColumnDef<BankAccount>[] = [
    {
      id: 'name',
      header: tbp.columns.name,
      width: 'flex-1',
      render: (a) => (
        <div className="flex items-center gap-2 min-w-0">
          <Landmark className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="font-medium truncate">{a.name}</span>
          {a.isDefault ? (
            <Badge variant="secondary" className="ml-1">{tbp.badges.default}</Badge>
          ) : null}
          {a.isActive === false ? (
            <Badge variant="outline" className="ml-1">{tbp.badges.inactive}</Badge>
          ) : null}
        </div>
      ),
    },
    {
      id: 'iban',
      header: tbp.columns.iban,
      width: 'w-[200px]',
      render: (a) => (
        <span className="font-mono text-sm text-muted-foreground">{a.iban || '—'}</span>
      ),
    },
    {
      id: 'bank',
      header: tbp.columns.bank,
      width: 'w-[160px]',
      render: (a) => <span className="text-muted-foreground">{a.bankName ?? '—'}</span>,
    },
    {
      id: 'currency',
      header: tbp.columns.currency,
      width: 'w-[100px]',
      render: (a) => <span className="text-muted-foreground">{a.currency ?? 'EUR'}</span>,
    },
    {
      id: 'balance',
      header: tbp.columns.balance,
      width: 'w-[180px]',
      render: (a) => (
        <span className="tabular-nums font-medium">
          {formatBalance(a.currentBalance, a.currency)}
        </span>
      ),
    },
  ];

  return (
    <>
      <WeldbooksEntityList<BankAccount>
        items={accounts}
        isLoading={isLoading}
        columns={columns}
        onRowClick={(a) => navigate({ to: `/weldbooks/banking/${a.id}` as any })}
        searchFields={['name', 'iban', 'bankName']}
        searchPlaceholder={tbp.columns.name}
        createButton={{ label: tbp.addBankAccount, onClick: () => setCreateOpen(true) }}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <Landmark className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
            </EmptyStateIllustration>
          ),
          title: tbp.noBankAccountsTitle,
          description: tbp.noBankAccountsDesc,
          action: {
            label: tbp.addFirstAccount,
            onClick: () => setCreateOpen(true),
          },
        }}
      />

      <BankAccountFormDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
