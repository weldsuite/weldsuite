import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import type { LegalEntity, LegalEntityBankAccount } from '@weldsuite/app-api-client/schemas/legal-entities';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { ErrorBanner, ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { BankAccountForm, RevealAccountNumber } from '@/components/legal-entity/bank-account-form';
import { useDeleteBankAccount, useLegalEntityBankAccounts } from '@/hooks/queries/use-legal-entities-queries';
import { useI18n } from '@/lib/i18n/provider';

interface BankAccountsTabProps {
  entity: LegalEntity;
  canEdit: boolean;
}

export function BankAccountsTab({ entity, canEdit }: Readonly<BankAccountsTabProps>) {
  const { t } = useI18n();
  const tb = t.settings.legalEntities.bankAccounts;
  const { data, isLoading, error, refetch } = useLegalEntityBankAccounts(entity.id);
  const remove = useDeleteBankAccount(entity.id);
  const [editing, setEditing] = useState<LegalEntityBankAccount | 'new' | null>(null);
  const [deleting, setDeleting] = useState<LegalEntityBankAccount | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function confirmDelete() {
    if (!deleting) return;
    try {
      await remove.mutateAsync(deleting.id);
      toast.success(tb.deleted);
      setDeleting(null);
      setDeleteError(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : tb.failed);
    }
  }

  let body: ReactNode;
  if (isLoading) {
    body = <PageLoader fullScreen={false} className="min-h-[120px] pb-0" />;
  } else if (error) {
    body = <ErrorState message={tb.loadFailed} onRetry={() => refetch()} />;
  } else if (!data || data.length === 0) {
    body = <EmptyText>{tb.empty}</EmptyText>;
  } else {
    body = (
      <ul className="divide-y rounded-md border">
        {data.map((account) => (
          <li key={account.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{account.name}</span>
                {account.isDefault && <SoftBadge tone="success">{tb.defaultBadge}</SoftBadge>}
                {account.inWeldbooks && <Badge variant="outline">{tb.inWeldbooks}</Badge>}
                {!account.isActive && <SoftBadge tone="neutral">{tb.inactiveBadge}</SoftBadge>}
              </div>
              {account.iban && <p className="break-all font-mono text-sm">{account.iban}</p>}
              <p className="text-xs text-muted-foreground">
                {[account.bankName, account.bic, account.routingNumber, account.currency].filter(Boolean).join(' · ')}
              </p>
              <RevealAccountNumber entityId={entity.id} account={account} />
            </div>
            {canEdit && (
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" aria-label={tb.editTitle} onClick={() => setEditing(account)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t.settings.legalEntities.detail.delete}
                  onClick={() => {
                    setDeleteError(null);
                    setDeleting(account);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <SectionCard
      title={tb.title}
      description={tb.description}
      action={
        canEdit ? (
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus className="mr-2 h-4 w-4" />
            {tb.add}
          </Button>
        ) : undefined
      }
    >
      {body}
      <BankAccountForm
        entityId={entity.id}
        account={editing === 'new' ? null : editing}
        defaultCurrency={entity.baseCurrency}
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={tb.deleteTitle}
        description={
          <>
            {tb.deleteDescription}
            {deleteError && <ErrorBanner error={deleteError} className="mt-3" />}
          </>
        }
        confirmLabel={t.settings.legalEntities.detail.delete}
        variant="destructive"
        onConfirm={confirmDelete}
      />
    </SectionCard>
  );
}
