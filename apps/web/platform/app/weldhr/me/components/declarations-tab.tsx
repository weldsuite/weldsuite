/** My HR → Declarations: what is still outstanding, the history, a new declaration, and withdrawing one. */

import { useState } from 'react';
import { toast } from 'sonner';
import { Paperclip, Plus } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrSelfDeclaration } from '@weldsuite/app-api-client/domains/weldhr';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  useMyHrCancelDeclaration,
  useMyHrDeclarations,
  useMyHrOpenDeclarationReceipt,
} from '@/hooks/queries/use-weldhr-queries';
import { EmptyText, SectionCard } from '../../components/page-kit';
import { ErrorBanner, StatusBadge, errorMessage, formatDate, formatMoney } from '../../components/shared';
import { MyDeclarationDialog } from './declaration-dialog';
import { Meta, TabLoading } from './shared';

export function MyDeclarationsTab({ canSubmit }: Readonly<{ canSubmit: boolean }>) {
  const t = useTranslations();
  const { data, isLoading, error } = useMyHrDeclarations();
  const cancelDeclaration = useMyHrCancelDeclaration();
  const openReceipt = useMyHrOpenDeclarationReceipt();
  const [creating, setCreating] = useState(false);
  const [withdrawTarget, setWithdrawTarget] = useState<HrSelfDeclaration | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  if (isLoading) return <TabLoading />;
  if (!data) return <ErrorBanner error={errorMessage(error, t('weldhr.me.declarations.loadFailed'))} />;

  async function confirmWithdraw(declaration: HrSelfDeclaration) {
    setFailure(null);
    try {
      await cancelDeclaration.mutateAsync(declaration.id);
      toast.success(t('weldhr.me.declarations.withdrawConfirm.toast'));
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.me.declarations.withdrawConfirm.failed')));
    } finally {
      setWithdrawTarget(null);
    }
  }

  function downloadReceipt(declaration: HrSelfDeclaration) {
    openReceipt.mutate(declaration, {
      onError: (err) => setFailure(errorMessage(err, t('weldhr.me.declarations.list.receiptFailed'))),
    });
  }

  return (
    <div className="space-y-4">
      <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

      <SectionCard
        title={t('weldhr.me.declarations.open.title')}
        action={
          canSubmit && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="mr-1.5 h-4 w-4" />
              {t('weldhr.me.declarations.newDeclaration')}
            </Button>
          )
        }
      >
        {!canSubmit && <p className="pb-3 text-sm text-muted-foreground">{t('weldhr.me.declarations.submitOff')}</p>}
        {data.open.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('weldhr.me.declarations.open.none')}</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {data.open.map((total) => (
              <dl key={total.currency} className="space-y-1.5 rounded-md border p-3 text-sm">
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">{t('weldhr.me.declarations.open.pending')}</dt>
                  <dd className="font-medium tabular-nums">{formatMoney(total.pending, total.currency)}</dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">{t('weldhr.me.declarations.open.approved')}</dt>
                  <dd className="font-medium tabular-nums">{formatMoney(total.approved, total.currency)}</dd>
                </div>
              </dl>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title={t('weldhr.me.declarations.list.title')} contentClassName="p-0">
        {data.declarations.length === 0 ? (
          <EmptyText>{t('weldhr.me.declarations.list.empty')}</EmptyText>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('weldhr.me.declarations.list.table.date')}</TableHead>
                <TableHead>{t('weldhr.me.declarations.list.table.description')}</TableHead>
                <TableHead>{t('weldhr.me.declarations.list.table.amount')}</TableHead>
                <TableHead>{t('weldhr.me.declarations.list.table.status')}</TableHead>
                <TableHead className="w-px" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.declarations.map((declaration) => (
                <TableRow key={declaration.id}>
                  <TableCell className="whitespace-nowrap">{formatDate(declaration.expenseDate)}</TableCell>
                  <TableCell>
                    <span>{declaration.description}</span>
                    <Meta>{t(`weldhr.declarations.category.${declaration.category}`)}</Meta>
                    {declaration.reviewNote && (
                      <Meta>{t('weldhr.me.declarations.list.reviewNote', { note: declaration.reviewNote })}</Meta>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {formatMoney(declaration.amount, declaration.currency)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge group="declaration" status={declaration.status} />
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {declaration.hasReceipt && (
                        <Button size="sm" variant="ghost" disabled={openReceipt.isPending} onClick={() => downloadReceipt(declaration)}>
                          <Paperclip className="mr-1.5 h-3.5 w-3.5" />
                          {t('weldhr.me.declarations.list.receipt')}
                        </Button>
                      )}
                      {declaration.status === 'pending' && (
                        <Button size="sm" variant="ghost" onClick={() => setWithdrawTarget(declaration)}>
                          {t('weldhr.me.declarations.list.withdraw')}
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      {creating && <MyDeclarationDialog onClose={() => setCreating(false)} />}

      {withdrawTarget && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setWithdrawTarget(null)}
          title={t('weldhr.me.declarations.withdrawConfirm.title')}
          description={t('weldhr.me.declarations.withdrawConfirm.description', {
            amount: formatMoney(withdrawTarget.amount, withdrawTarget.currency),
            date: formatDate(withdrawTarget.expenseDate),
          })}
          variant="destructive"
          confirmLabel={t('weldhr.me.declarations.withdrawConfirm.confirm')}
          cancelLabel={t('weldhr.me.declarations.withdrawConfirm.keep')}
          onConfirm={() => confirmWithdraw(withdrawTarget)}
        />
      )}
    </div>
  );
}
