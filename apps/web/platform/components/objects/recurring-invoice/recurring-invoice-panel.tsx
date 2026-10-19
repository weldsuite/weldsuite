/**
 * Recurring invoice template object panel (WeldBooks).
 *
 * Built on the shell of the company / person / bank account panels
 * (`useObjectPanelShell` + `EntityDetailView` + tabs). It replaces the
 * standalone `/weldbooks/recurring/:id` page, which now redirects to the list
 * with this panel open in fullscreen.
 *
 * Tabs: Details · Template items · History. Editing the template opens the
 * form in the panel's body, in fullscreen where it has room.
 */

import { useMemo, useState } from 'react';
import { useCan } from '@weldsuite/permissions/react';
import { useTranslations } from '@weldsuite/i18n/client';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import {
  useObjectPanel,
  useObjectPanelShell,
  type ObjectPanelComponentProps,
} from '@/components/object-panel';
import { EntityAuditPanel } from '@/components/entity-audit-panel';
import { ConfigurablePanelTabs } from '@/components/objects/_shared/configurable-panel-tabs';
import { tabBodyClassName } from '@/components/objects/_shared/tab-empty-state';
import { useAccountingCustomer } from '@/hooks/queries/use-accounting-queries';
import {
  useGenerateRecurringInvoice,
  usePauseRecurringInvoice,
  useRecurringInvoice,
  useResumeRecurringInvoice,
} from '@/hooks/queries/use-weldbooks-recurring-queries';
import type { RecurringInvoice } from '@/lib/api/domains/weldbooks';
import type { RecurringTemplateTaxItem } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { useI18n } from '@/lib/i18n/provider';
import { RecurringInvoiceForm } from '@/app/weldbooks/recurring/components/recurring-invoice-form';
import {
  GenerationResult,
  RecurringActionBar,
  RecurringHeaderActions,
  RecurringTitle,
} from './recurring-invoice-header';
import { RecurringDetailsTab, RecurringItemsTab } from './recurring-invoice-tab-bodies';
import { getRecurringInvoiceTabs, type RecurringInvoiceTabId } from './recurring-invoice-tabs';

const RECURRING_PANEL_WIDTH = 480;

const TAB_IDS: readonly RecurringInvoiceTabId[] = ['overview', 'items', 'history'];

function isTabId(value: string | undefined): value is RecurringInvoiceTabId {
  return TAB_IDS.includes(value as RecurringInvoiceTabId);
}

/** The API answered 404: the template was deleted, or the link is wrong. */
function isNotFound(error: unknown): boolean {
  return (error as { status?: number } | null)?.status === 404;
}

function RecurringTabBody({
  tab,
  recurring,
  customerName,
  onOpenInvoice,
}: Readonly<{
  tab: RecurringInvoiceTabId;
  recurring: RecurringInvoice;
  customerName: string | null;
  onOpenInvoice: (id: string) => void;
}>) {
  const template = recurring.templateData ?? {};
  switch (tab) {
    case 'overview':
      return <RecurringDetailsTab recurring={recurring} customerName={customerName} onOpenInvoice={onOpenInvoice} />;
    case 'items':
      return (
        <RecurringItemsTab items={(template.items ?? []) as RecurringTemplateTaxItem[]} currency={template.currency} />
      );
    case 'history':
      return <EntityAuditPanel entityType="recurring_invoice" entityId={recurring.id} />;
  }
}

export function RecurringInvoicePanel(props: Readonly<ObjectPanelComponentProps>) {
  const { id, initialTab } = props;
  const { t } = useI18n();
  const st = useTranslations();
  const trp = t.accounting.recurringPage;
  const canUpdate = useCan('invoices:update');
  const { open: openPanel } = useObjectPanel();

  const recurringQuery = useRecurringInvoice(id);
  const recurring = recurringQuery.data?.data;
  const { data: customerData } = useAccountingCustomer(recurring?.contactId ?? '');

  const generateMutation = useGenerateRecurringInvoice();
  const pauseMutation = usePauseRecurringInvoice();
  const resumeMutation = useResumeRecurringInvoice();

  const [editing, setEditing] = useState(false);

  const shell = useObjectPanelShell({
    ...props,
    width: RECURRING_PANEL_WIDTH,
    loading: recurringQuery.isLoading && !recurring,
  });

  const itemCount = recurring?.templateData?.items?.length ?? 0;
  const tabs = useMemo(
    () =>
      getRecurringInvoiceTabs({
        details: st('sweep.entities.detailsTab'),
        items: trp.templateItems,
        history: st('sweep.entities.auditLogTab'),
        itemsCount: itemCount || undefined,
      }),
    [st, trp.templateItems, itemCount],
  );
  const [activeTab, setActiveTab] = useState<RecurringInvoiceTabId>(isTabId(initialTab) ? initialTab : 'overview');

  /** The invoice a generation made: opened in place, with a back arrow to this template. */
  const openInvoice = (invoiceId: string) => openPanel({ type: 'invoice', id: invoiceId, stack: true });

  // The template form is wide: give it the whole page rather than a 480px column.
  const startEditing = () => {
    shell.setMode('fullscreen');
    setEditing(true);
  };

  const showTabs = Boolean(recurring) && !editing;

  return (
    <EntityDetailView
      {...shell.entityDetailViewProps}
      contentClassName={tabBodyClassName(shell.mode)}
      title={<RecurringTitle recurring={recurring} />}
      actions={<RecurringHeaderActions recurring={recurring} canUpdate={canUpdate} onEdit={startEditing} />}
      subheader={
        recurring && !editing ? (
          <RecurringActionBar
            status={recurring.status}
            generating={generateMutation.isPending}
            pausing={pauseMutation.isPending}
            resuming={resumeMutation.isPending}
            onGenerate={() => generateMutation.mutate(id)}
            onPause={() => pauseMutation.mutate(id)}
            onResume={() => resumeMutation.mutate(id)}
          />
        ) : null
      }
      tabs={
        showTabs ? (
          <ConfigurablePanelTabs
            objectType="recurring_invoice"
            tabs={tabs}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            mode={shell.mode}
          />
        ) : undefined
      }
    >
      {!recurringQuery.isLoading && recurringQuery.isError && !isNotFound(recurringQuery.error) && (
        <div className="p-4 text-sm text-destructive">{st('sweep.entities.failedToLoad')}</div>
      )}
      {!recurringQuery.isLoading && !recurring && (!recurringQuery.isError || isNotFound(recurringQuery.error)) && (
        <div className="p-6 text-center text-sm text-muted-foreground">{trp.notFound}</div>
      )}

      {recurring && !editing && (
        <GenerationResult
          error={generateMutation.isError ? generateMutation.error : null}
          generated={generateMutation.data?.data}
          onOpenInvoice={openInvoice}
        />
      )}

      {recurring && editing && (
        <div className="p-4">
          <RecurringInvoiceForm
            mode="edit"
            recurring={recurring}
            onSaved={() => setEditing(false)}
            onCancel={() => setEditing(false)}
          />
        </div>
      )}

      {recurring && !editing && (
        <RecurringTabBody
          tab={activeTab}
          recurring={recurring}
          customerName={customerData?.data?.name ?? null}
          onOpenInvoice={openInvoice}
        />
      )}
    </EntityDetailView>
  );
}
