/**
 * Payment run object panel (WeldBooks).
 *
 * Built on the same shell as the company / person / domain / bank account
 * panels: `useObjectPanelShell` + `EntityDetailView` + the configurable tab
 * strip, so it inherits the shared header chrome, the panel↔fullscreen toggle
 * and the stacking/back behaviour. It replaces the standalone
 * `/weldbooks/payment-runs/:id` page, which now redirects to the list with
 * this panel open in fullscreen. The checks page (`…/:id/checks`) stays a page:
 * the panel links to it, as the old page did.
 *
 * Tabs: Details · Vendors · Bills · Holds · Approvals · History. The Details
 * tab carries what the member can do next (submit, approve, reject, cancel,
 * print checks) and the ACH file.
 */

import { useMemo } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { EllipsisVertical, Link as LinkIcon } from 'lucide-react';
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
import { ConfigurablePanelTabs } from '@/components/objects/_shared/configurable-panel-tabs';
import { useCopyPanelLink } from '@/components/objects/_shared/record-panel-parts';
import { RunStatusChip } from '@/app/weldbooks/payment-runs/components/run-badges';
import { isRunOpen } from '@/app/weldbooks/payment-runs/payment-run-utils';
import { useMemberNames } from '@/app/weldbooks/payment-runs/use-member-names';
import { usePaymentRun } from '@/hooks/queries/use-weldbooks-payment-runs-queries';
import { isWeldbooksRequestError } from '@/lib/api/domains/weldbooks-banking';
import type { PaymentRunDetail } from '@/lib/api/domains/weldbooks-payment-runs';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { PaymentRunDetailsTab } from './payment-run-details-tab';
import { PaymentRunBillsTab, PaymentRunHoldsTab, PaymentRunVendorsTab } from './payment-run-lists';
import { PaymentRunDialogs, usePaymentRunActions } from './payment-run-actions';
import { getPaymentRunTabs, type PaymentRunTab } from './payment-run-tabs';
import { PaymentRunApprovalsTab, PaymentRunHistoryTab } from './payment-run-timeline-tabs';

const PAYMENT_RUN_PANEL_WIDTH = 480;

function PaymentRunTitle({ run }: Readonly<{ run?: PaymentRunDetail }>) {
  const { t } = useI18n();
  const { formatDate } = useWeldbooksFormat();
  if (!run) return <div className="h-4 w-32 rounded bg-muted animate-pulse" />;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="relative top-px truncate text-[15px] font-medium text-foreground">
        {t.weldbooksUs.payments.detail.title} · {formatDate(run.paymentDate)}
      </span>
      <span className="flex-shrink-0">
        <RunStatusChip status={run.status} />
      </span>
    </div>
  );
}

function PaymentRunMenu({ run }: Readonly<{ run?: PaymentRunDetail }>) {
  const st = useTranslations();
  const copyLink = useCopyPanelLink('/weldbooks/payment-runs', 'payment_run', run?.id ?? '');
  if (!run) return null;
  return (
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
  );
}

/** The run could not be loaded: not found, or a failure that can be retried. */
function RunLoadError({ error, onRetry }: Readonly<{ error: unknown; onRetry: () => void }>) {
  const { t } = useI18n();
  const tp = t.weldbooksUs.payments;
  const notFound = isWeldbooksRequestError(error) && error.status === 404;
  return (
    <div className="space-y-3 p-4">
      <p className="text-sm text-destructive" role="alert">
        {notFound ? tp.detail.notFound : tp.common.loadFailed}
      </p>
      {notFound ? null : (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {tp.common.retry}
        </Button>
      )}
    </div>
  );
}

export function PaymentRunPanel(props: Readonly<ObjectPanelComponentProps>) {
  const { id, onClose, initialTab } = props;
  const { t } = useI18n();
  const st = useTranslations();
  const tp = t.weldbooksUs.payments;
  const { can } = usePermissions();
  const { userId } = useAuth();
  const nameOf = useMemberNames();

  const runQuery = usePaymentRun(id);
  const run = runQuery.data;
  const canCreate = can('banking:create');
  const canManage = can('banking:manage');

  const actions = usePaymentRunActions(run, onClose);

  const shell = useObjectPanelShell({
    ...props,
    width: PAYMENT_RUN_PANEL_WIDTH,
    loading: runQuery.isLoading && !run,
  });

  const tabs = useMemo(
    () =>
      getPaymentRunTabs({
        details: st('sweep.entities.detailsTab'),
        vendors: tp.list.columns.vendors,
        bills: tp.list.columns.bills,
        holds: tp.holds.title,
        approvals: tp.detail.approvals.title,
        history: tp.detail.history.title,
        vendorsCount: run?.vendors.length || undefined,
        billsCount: run?.items.length || undefined,
        holdsCount: run?.holds.length,
      }),
    [st, tp, run?.vendors.length, run?.items.length, run?.holds.length],
  );

  // A deep-linked tab that only appears once the record is loaded is applied when it does.
  const [activeTab, setActiveTab] = usePanelInitialTab<PaymentRunTab['id']>(tabs, initialTab, 'overview');

  return (
    <>
      <EntityDetailView
        {...shell.entityDetailViewProps}
        title={<PaymentRunTitle run={run} />}
        actions={<PaymentRunMenu run={run} />}
        tabs={
          <ConfigurablePanelTabs
            objectType="payment_run"
            tabs={tabs}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            mode={shell.mode}
          />
        }
      >
        {!runQuery.isLoading && !run && (
          <RunLoadError error={runQuery.error} onRetry={() => void runQuery.refetch()} />
        )}

        {run && activeTab === 'overview' && (
          <PaymentRunDetailsTab
            run={run}
            userId={userId}
            canCreate={canCreate}
            canManage={canManage}
            busy={actions.busy}
            on={actions.on}
          />
        )}
        {run && activeTab === 'vendors' && <PaymentRunVendorsTab run={run} />}
        {run && activeTab === 'bills' && <PaymentRunBillsTab run={run} />}
        {run && activeTab === 'holds' && (
          <PaymentRunHoldsTab
            run={run}
            nameOf={nameOf}
            canRelease={canManage && isRunOpen(run.status)}
            onRelease={actions.releaseHold}
          />
        )}
        {run && activeTab === 'approvals' && <PaymentRunApprovalsTab run={run} nameOf={nameOf} />}
        {run && activeTab === 'history' && <PaymentRunHistoryTab history={run.history} nameOf={nameOf} />}
      </EntityDetailView>

      {run ? <PaymentRunDialogs run={run} actions={actions} canManage={canManage} /> : null}
    </>
  );
}
