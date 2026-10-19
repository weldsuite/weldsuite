/**
 * Bill object panel (WeldBooks).
 *
 * Built on the same shell as the company / person / domain / bank account
 * panels: `useObjectPanelShell` + `EntityDetailView` + the configurable tab
 * strip, so it inherits the shared header chrome, the panel↔fullscreen toggle
 * and the stacking/back behaviour. It replaces the standalone
 * `/weldbooks/bills/:id` page, which now redirects to the list with this panel
 * open in fullscreen.
 *
 * The panel does not depend on any WeldBooks route: the entity sheet (chat
 * mentions, search) renders it wherever it is opened from.
 *
 * Tabs: Details · Line items · Tax · History. Approving and rejecting a bill
 * that waits for approval sits under the header, whichever tab is open.
 */

import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { EllipsisVertical, Link as LinkIcon, Pencil } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { useObjectPanelShell, type ObjectPanelComponentProps } from '@/components/object-panel';
import { usePanelInitialTab } from '@/components/objects/_shared/use-panel-initial-tab';
import { EntityAuditPanel } from '@/components/entity-audit-panel';
import { StatusChip } from '@/components/accounting/weldbooks-row-cells';
import { ConfigurablePanelTabs } from '@/components/objects/_shared/configurable-panel-tabs';
import { useCopyPanelLink } from '@/components/objects/_shared/record-panel-parts';
import { useAccountingBill } from '@/hooks/queries/use-accounting-queries';
import type { BillWithTax } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { useI18n } from '@/lib/i18n/provider';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import { BillApprovalBar, RejectBillDialog, useBillApproval } from './bill-approval';
import { BillDetailsTab } from './bill-details-tab';
import { BillLineItemsTab, BillTaxTab, hasBillTaxTab } from './bill-items-tab';
import { getBillTabs, type BillTab } from './bill-tabs';

const BILL_PANEL_WIDTH = 480;

type StatusLabels = Record<string, string>;

function BillTitle({
  bill,
  fallback,
  statusLabels,
}: Readonly<{ bill?: BillWithTax; fallback: string; statusLabels: StatusLabels }>) {
  if (!bill) return <div className="h-4 w-32 rounded bg-muted animate-pulse" />;
  // An approved bill's approval status says what its status already says.
  const showApproval = !!bill.approvalStatus && bill.approvalStatus !== 'approved';
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="relative top-px truncate text-[15px] font-medium text-foreground">{bill.billNumber ?? fallback}</span>
      <StatusChip status={bill.status}>{statusLabels[bill.status] ?? bill.status}</StatusChip>
      {showApproval && bill.approvalStatus ? (
        <StatusChip status={bill.approvalStatus}>
          {statusLabels[bill.approvalStatus] ?? bill.approvalStatus}
        </StatusChip>
      ) : null}
    </div>
  );
}

function BillActions({
  bill,
  canEdit,
}: Readonly<{ bill?: BillWithTax; canEdit: boolean }>) {
  const { t } = useI18n();
  const st = useTranslations();
  const copyLink = useCopyPanelLink('/weldbooks/bills', 'bill', bill?.id ?? '');
  if (!bill) return null;

  return (
    <div className="flex items-center gap-0.5">
      {canEdit ? (
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-7"
          title={t.accounting.billDetail.edit}
          aria-label={t.accounting.billDetail.edit}
          asChild
        >
          <Link to="/weldbooks/bills/$id/edit" params={{ id: bill.id }}>
            <Pencil className="h-4 w-4 text-muted-foreground" />
          </Link>
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7 data-[state=open]:bg-accent dark:data-[state=open]:bg-accent/50"
            aria-label={st('sweep.entities.moreActions')}
          >
            <EllipsisVertical className="h-4 w-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => void copyLink()}>
            <LinkIcon />
            {st('sweep.entities.copyLink')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function BillPanel(props: Readonly<ObjectPanelComponentProps>) {
  const { id, initialTab } = props;
  const { t } = useI18n();
  const st = useTranslations();
  const { can } = usePermissions();
  const { features } = useJurisdictionLabels();
  const tb = t.accounting.billDetail;
  const statusLabels = t.accounting.statusLabels.bill as StatusLabels;

  const billQuery = useAccountingBill(id);
  const bill = billQuery.data?.data as unknown as BillWithTax | undefined;

  const canUpdate = can('bills:update');
  const isDraft = bill?.status === 'draft';
  const isPendingApproval = bill?.approvalStatus === 'pending' || bill?.status === 'pending_approval';
  const approval = useBillApproval(id);

  const shell = useObjectPanelShell({
    ...props,
    width: BILL_PANEL_WIDTH,
    loading: billQuery.isLoading && !bill,
  });

  const showTax = hasBillTaxTab(bill, features.salesTax);
  const tabs = useMemo(
    () =>
      getBillTabs({
        details: st('sweep.entities.detailsTab'),
        items: tb.lineItems,
        tax: tb.tax,
        history: st('sweep.entities.auditLogTab'),
        itemsCount: bill?.items?.length || undefined,
        showTax,
      }),
    [st, tb, bill?.items?.length, showTax],
  );

  // A deep-linked tab that only appears once the record is loaded is applied when it does.
  const [activeTab, setActiveTab] = usePanelInitialTab<BillTab['id']>(tabs, initialTab, 'overview');

  return (
    <>
      <EntityDetailView
        {...shell.entityDetailViewProps}
        title={
          <BillTitle
            bill={bill}
            fallback={st('sweep.weldbooks.billDetail.billFallback')}
            statusLabels={statusLabels}
          />
        }
        actions={<BillActions bill={bill} canEdit={isDraft && canUpdate} />}
        subheader={
          bill ? (
            <BillApprovalBar approval={approval} canAct={isPendingApproval && canUpdate} />
          ) : undefined
        }
        tabs={
          <ConfigurablePanelTabs
            objectType="bill"
            tabs={tabs}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            mode={shell.mode}
          />
        }
      >
        {!billQuery.isLoading && billQuery.isError && (
          <div className="p-4 text-sm text-destructive">{st('sweep.entities.failedToLoad')}</div>
        )}
        {!billQuery.isLoading && !billQuery.isError && !bill && (
          <div className="p-6 text-center text-sm text-muted-foreground">{tb.billNotFound}</div>
        )}

        {bill && activeTab === 'overview' && <BillDetailsTab bill={bill} />}
        {bill && activeTab === 'items' && <BillLineItemsTab bill={bill} />}
        {bill && activeTab === 'tax' && <BillTaxTab bill={bill} />}
        {bill && activeTab === 'history' && <EntityAuditPanel entityType="bill" entityId={bill.id} />}
      </EntityDetailView>

      <RejectBillDialog approval={approval} />
    </>
  );
}
