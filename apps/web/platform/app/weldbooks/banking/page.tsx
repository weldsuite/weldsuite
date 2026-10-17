import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ClipboardCheck, Download, Landmark, Wallet } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import {
  RowAmount,
  RowChip,
  RowText,
  RowTitle,
} from '@/components/accounting/weldbooks-row-cells';
import { EmptyStateIllustration, type ColumnDef } from '@/components/entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { useBankAccounts } from '@/hooks/queries/use-weldbooks-banking-queries';
import { isLiabilityAccountType, type UsBankAccount } from '@/lib/api/domains/weldbooks-banking';
import { useI18n } from '@/lib/i18n/provider';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import { isUsJurisdictionCode } from '@/lib/weldbooks/us-entity';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { BankFeedsStrip } from './feeds/bank-feeds-strip';
import { useConnectBankLauncher } from './feeds/connect-bank-button';
import { BankAccountFormDialog } from './components/bank-account-form-dialog';
import { maskedAccountNumber } from './components/routing-number';
import { UndepositedFundsCallout } from './components/undeposited-funds-callout';

export default function BankAccountsPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const { data, isLoading } = useBankAccounts();
  // Each account opens in the shared object panel (type 'bank_account'), the
  // same panel/fullscreen shell as WeldCRM companies, synced to `?stack=`.
  const { open: openPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldbooks/banking');
  const { t } = useI18n();
  const tbp = t.accounting.bankingPages;
  const tb = t.weldbooksUs.banking;
  const tf = t.weldbooksUs.bankFeeds;
  const { entityCurrency, formatMoney } = useWeldbooksFormat();
  const { code: jurisdictionCode } = useCurrentJurisdiction();
  const { can } = usePermissions();
  const isUs = isUsJurisdictionCode(jurisdictionCode);
  const launcher = useConnectBankLauncher();

  const accounts = data?.data ?? [];
  const hasAccounts = accounts.length > 0;
  // With no accounts yet, a bank feed is the quickest way to get them, so the
  // empty state leads with it when this entity's country has a provider.
  const offerFeed = launcher.allowed && launcher.available;
  const awaitingProviders = !hasAccounts && launcher.allowed && launcher.loading;

  const columns: ColumnDef<UsBankAccount>[] = [
    {
      id: 'name',
      header: tbp.columns.name,
      width: 'min-w-[200px] flex-1 gap-2',
      render: (a) => (
        <RowTitle
          chips={
            <>
              {a.isDefault ? <RowChip>{tbp.badges.default}</RowChip> : null}
              {a.isActive === false ? <RowChip tone="gray">{tbp.badges.inactive}</RowChip> : null}
            </>
          }
        >
          {a.name}
        </RowTitle>
      ),
    },
    ...(isUs
      ? [
          {
            id: 'type',
            header: tb.accountList.type,
            width: 'w-[150px] gap-1.5',
            render: (a: UsBankAccount) => (
              <>
                <RowText>{a.accountType ? tb.accountTypes[a.accountType] : null}</RowText>
                {isLiabilityAccountType(a.accountType) ? (
                  <RowChip tone="gray">{tb.accountList.liability}</RowChip>
                ) : null}
              </>
            ),
          },
          {
            id: 'account',
            header: tb.accountList.account,
            width: 'w-[140px]',
            render: (a: UsBankAccount) => (
              <span className="min-w-0" data-testid="account-last4">
                <RowText className="font-mono">
                  {a.accountNumberLast4 ? maskedAccountNumber(a.accountNumberLast4) : null}
                </RowText>
              </span>
            ),
          },
        ]
      : [
          {
            id: 'iban',
            header: tbp.columns.iban,
            width: 'w-[200px]',
            render: (a: UsBankAccount) => <RowText className="font-mono">{a.iban}</RowText>,
          },
        ]),
    {
      id: 'bank',
      header: tbp.columns.bank,
      width: 'w-[160px]',
      render: (a) => <RowText>{a.bankName}</RowText>,
    },
    {
      id: 'currency',
      header: tbp.columns.currency,
      width: 'w-[100px]',
      render: (a) => <RowText>{a.currency ?? entityCurrency}</RowText>,
    },
    {
      id: 'balance',
      header: tbp.columns.balance,
      width: 'w-[180px]',
      render: (a) => <RowAmount>{formatMoney(a.currentBalance, a.currency ?? entityCurrency)}</RowAmount>,
    },
  ];

  return (
    <>
      <div className="space-y-3 px-4 pt-4 empty:hidden">
        <UndepositedFundsCallout />
        <BankFeedsStrip hasAccounts={hasAccounts} />
      </div>

      <WeldbooksEntityList<UsBankAccount>
        items={accounts}
        isLoading={isLoading || awaitingProviders}
        columns={columns}
        onRowClick={(a) => openPanel({ type: 'bank_account', id: a.id })}
        getRowLabel={(a) => a.name}
        searchFields={['name', 'iban', 'bankName']}
        searchPlaceholder={tbp.columns.name}
        createButton={{ label: tbp.addBankAccount, onClick: () => setCreateOpen(true) }}
        actionButtons={
          hasAccounts ? (
            <>
              <Button variant="outline" size="sm" asChild>
                <Link to="/weldbooks/banking/import">
                  <Download className="h-4 w-4" />
                  {tbp.importStatement}
                </Link>
              </Button>
              {isUs ? (
                <>
                  <Button variant="outline" size="sm" asChild>
                    <Link to="/weldbooks/banking/statements">
                      <ClipboardCheck className="h-4 w-4" />
                      {tb.accountList.reconcileStatement}
                    </Link>
                  </Button>
                  {can('banking:create') ? (
                    <Button variant="outline" size="sm" asChild>
                      <Link to="/weldbooks/deposits/new">
                        <Wallet className="h-4 w-4" />
                        {tb.accountList.makeDeposit}
                      </Link>
                    </Button>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null
        }
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <Landmark className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
            </EmptyStateIllustration>
          ),
          title: tbp.noBankAccountsTitle,
          ...(offerFeed
            ? {
                description: tf.emptyAccounts.description,
                action: {
                  label: tf.connectBank,
                  onClick: () => {
                    if (!launcher.disabled) launcher.start();
                  },
                },
                secondaryAction: { label: tf.emptyAccounts.addManually, onClick: () => setCreateOpen(true) },
              }
            : {
                description: tbp.noBankAccountsDesc,
                action: { label: tbp.addFirstAccount, onClick: () => setCreateOpen(true) },
              }),
        }}
      />

      {launcher.elements}

      <BankAccountFormDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
