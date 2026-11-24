/**
 * My HR → Expenses → a declaration of your own: what it was, the amount and
 * receipt, HR's review and the payout, with "Download receipt" and, while it
 * waits for a decision, "Withdraw declaration".
 */

import { useState } from 'react';
import { toast } from 'sonner';
import {
  Banknote,
  CalendarCheck,
  CalendarDays,
  CalendarPlus,
  CircleDot,
  Download,
  FileText,
  MessageSquareText,
  Paperclip,
  Tag,
  Undo2,
  Wallet,
} from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { DropdownMenuItem } from '@weldsuite/ui/components/dropdown-menu';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import { ObjectPanelTabs, useObjectPanelShell, type ObjectPanelComponentProps } from '@/components/object-panel';
import { PanelRow } from '@/components/objects/_shared/record-panel-parts';
import { tabBodyClassName } from '@/components/objects/_shared/tab-empty-state';
import { useMyHrCancelDeclaration, useMyHrDeclarations } from '@/hooks/queries/use-weldhr-queries';
import { MY_HR_PATHS } from '@/app/weldhr/access';
import { StatusBadge, errorMessage, formatDate, formatMoney } from '@/app/weldhr/components/shared';
import { isWithdrawable, useDownloadMyReceipt } from '@/app/weldhr/me/components/declarations-tab';
import { MY_HR_PANEL_WIDTH, MyHrPanelMenu, MyHrPanelMissing, MyHrPanelTitle, useDetailsTab } from './parts';
import { MY_DECLARATION_PANEL_TYPE } from './types';

export function MyDeclarationPanel(props: Readonly<ObjectPanelComponentProps>) {
  const t = useTranslations();
  const { data, isLoading, error, refetch } = useMyHrDeclarations();
  const declaration = data?.declarations.find((d) => d.id === props.id);
  const cancelDeclaration = useMyHrCancelDeclaration();
  const receipt = useDownloadMyReceipt();
  const [withdrawing, setWithdrawing] = useState(false);
  const detailsTab = useDetailsTab();

  const shell = useObjectPanelShell({ ...props, width: MY_HR_PANEL_WIDTH, loading: isLoading && !data });

  async function confirmWithdraw() {
    if (!declaration) return;
    try {
      await cancelDeclaration.mutateAsync(declaration.id);
      toast.success(t('weldhr.me.declarations.withdrawConfirm.toast'));
    } catch (err) {
      toast.error(errorMessage(err, t('weldhr.me.declarations.withdrawConfirm.failed')));
    } finally {
      setWithdrawing(false);
    }
  }

  return (
    <EntityDetailView
      {...shell.entityDetailViewProps}
      contentClassName={tabBodyClassName(shell.mode)}
      title={
        <MyHrPanelTitle
          label={declaration?.description}
          status={declaration ? <StatusBadge group="declaration" status={declaration.status} /> : null}
        />
      }
      actions={
        declaration ? (
          <MyHrPanelMenu listPath={MY_HR_PATHS.expenses} type={MY_DECLARATION_PANEL_TYPE} id={declaration.id}>
            {declaration.hasReceipt ? (
              <DropdownMenuItem disabled={receipt.isPending} onClick={() => receipt.download(declaration)}>
                <Download />
                {t('weldhr.declarations.downloadReceipt')}
              </DropdownMenuItem>
            ) : null}
            {isWithdrawable(declaration) ? (
              <DropdownMenuItem variant="destructive" onClick={() => setWithdrawing(true)}>
                <Undo2 />
                {t('weldhr.me.declarations.withdrawConfirm.confirm')}
              </DropdownMenuItem>
            ) : null}
          </MyHrPanelMenu>
        ) : null
      }
      tabs={<ObjectPanelTabs tabs={[detailsTab]} activeTab={detailsTab.id} onChange={() => {}} />}
    >
      {!declaration && <MyHrPanelMissing loaded={!!data} error={error} onRetry={() => void refetch()} />}

      {declaration && (
        <div className="space-y-1 p-4">
          <PanelRow
            icon={FileText}
            label={t('weldhr.me.declarations.list.table.description')}
            value={declaration.description}
          />
          <PanelRow
            icon={Tag}
            label={t('weldhr.me.declarations.list.table.category')}
            value={t(`weldhr.declarations.category.${declaration.category}`)}
          />
          <PanelRow
            icon={CalendarDays}
            label={t('weldhr.me.declarations.list.table.date')}
            value={formatDate(declaration.expenseDate)}
            tabular
          />
          <PanelRow
            icon={Banknote}
            label={t('weldhr.me.declarations.list.table.amount')}
            value={formatMoney(declaration.amount, declaration.currency)}
            tabular
          />
          <PanelRow
            icon={CircleDot}
            label={t('weldhr.me.declarations.list.table.status')}
            value={declaration.status}
            renderValue={() => <StatusBadge group="declaration" status={declaration.status} />}
          />
          <PanelRow
            icon={Paperclip}
            label={t('weldhr.me.declarations.list.table.receipt')}
            value={declaration.hasReceipt ? (declaration.receiptFileName ?? t('weldhr.me.declarations.list.table.receipt')) : null}
            renderValue={(name) => (
              <button
                type="button"
                className="max-w-full truncate text-left text-primary hover:underline disabled:opacity-50"
                disabled={receipt.isPending}
                onClick={() => receipt.download(declaration)}
              >
                {name}
              </button>
            )}
          />
          <PanelRow
            icon={CalendarPlus}
            label={t('weldhr.me.declarations.panel.submittedOn')}
            value={formatDate(declaration.createdAt)}
            tabular
          />
          <PanelRow
            icon={CalendarCheck}
            label={t('weldhr.me.declarations.panel.reviewedOn')}
            value={declaration.reviewedAt ? formatDate(declaration.reviewedAt) : null}
            tabular
          />
          <PanelRow
            icon={MessageSquareText}
            label={t('weldhr.me.declarations.panel.reviewNote')}
            value={declaration.reviewNote}
          />
          <PanelRow
            icon={Wallet}
            label={t('weldhr.me.declarations.panel.paidOn')}
            value={declaration.paidAt ? formatDate(declaration.paidAt) : null}
            tabular
          />
        </div>
      )}

      {withdrawing && declaration && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setWithdrawing(false)}
          title={t('weldhr.me.declarations.withdrawConfirm.title')}
          description={t('weldhr.me.declarations.withdrawConfirm.description', {
            amount: formatMoney(declaration.amount, declaration.currency),
            date: formatDate(declaration.expenseDate),
          })}
          variant="destructive"
          confirmLabel={t('weldhr.me.declarations.withdrawConfirm.confirm')}
          cancelLabel={t('weldhr.me.declarations.withdrawConfirm.keep')}
          onConfirm={confirmWithdraw}
        />
      )}
    </EntityDetailView>
  );
}
