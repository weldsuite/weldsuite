
import { useMemo, useCallback, useState } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useRouter } from '@/lib/router';
import { DropdownMenuItem, DropdownMenuSeparator } from '@weldsuite/ui/components/dropdown-menu';
import {
  Trash2,
  ExternalLink,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useDeleteWebhook } from '@/hooks/queries/use-automation-queries';
import {
  EntityList,
  EmptyStateIllustration,
  type HeaderColumn,
  type FilterConfig,
  type ActiveFilter,
} from '@/components/entity-list';
import { WebhookStatusBadge } from './webhook-status-badge';
import { deriveWebhookStatus, webhookDisplayName } from './webhook-utils';
import {
  ConnectListRow,
  ConnectRowCell,
  ConnectRowMenu,
  DESTRUCTIVE_MENU_ITEM,
  RowChip,
  RowDate,
  RowText,
  RowTitle,
} from '../components/connect-list-row';

/**
 * A webhook as /api/workflow-webhooks returns it. Webhook URLs come from the
 * workflows themselves: saving a workflow with a Webhook trigger provisions
 * one (`isManaged`), and the trigger is where it is configured and removed.
 * Rows without a trigger are older, hand-made webhooks; only those can be
 * deleted here.
 */
export interface WebhookView {
  id: string;
  name: string;
  isEnabled: boolean;
  workflowId: string;
  workflowName?: string | null;
  /** The workflow's status (draft / active / paused / archived): calls are only accepted while it is active. */
  workflowStatus?: string | null;
  isManaged: boolean;
  createdAt: string;
  updatedAt: string;
  url: string;
  externalUrl: string;
  validateSignature: boolean;
  signatureHeader?: string | null;
  totalCalls?: number | null;
  successfulCalls?: number | null;
  failedCalls?: number | null;
  lastCalledAt?: string | null;
}

interface WebhooksClientProps {
  webhooks: WebhookView[];
  isLoading?: boolean;
}

export function WebhooksClient({ webhooks, isLoading = false }: Readonly<WebhooksClientProps>) {
  const { t } = useI18n();
  const wc = t.weldconnect.webhooksClient;
  const router = useRouter();

  useBreadcrumbs([
    { label: t.weldconnect.breadcrumbs.connect, href: '/weldconnect' },
    { label: t.weldconnect.breadcrumbs.webhooks },
  ]);

  const deleteWebhookMutation = useDeleteWebhook();
  const isPending = deleteWebhookMutation.isPending;
  const [pendingDelete, setPendingDelete] = useState<WebhookView | null>(null);

  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'name', header: wc.columnName, width: 'min-w-[200px] flex-1' },
    { id: 'status', header: wc.columnStatus, width: 'w-[110px]' },
    { id: 'workflow', header: wc.columnWorkflow, width: 'w-[180px]' },
    { id: 'calls', header: wc.columnCalls, width: 'w-[100px]' },
    { id: 'created', header: wc.columnCreated, width: 'w-[120px]' },
  ], [wc]);

  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'status',
      label: wc.columnStatus,
      options: [
        { value: 'active', label: t.weldconnect.webhooks.statuses.active },
        { value: 'draft', label: t.weldconnect.webhooks.statuses.draft },
        { value: 'paused', label: t.weldconnect.webhooks.statuses.paused },
        { value: 'disabled', label: t.weldconnect.webhooks.statuses.disabled },
      ],
      getDisplayValue: (value) =>
        (t.weldconnect.webhooks.statuses as Record<string, string>)[value] ?? value,
    },
  ], [t, wc.columnStatus]);

  const applyFilters = useCallback((items: WebhookView[], filters: ActiveFilter[]) => {
    let result = items;
    filters.forEach((filter) => {
      if (!filter.operator || !filter.value) return;
      if (filter.field === 'status') {
        const matches = (w: WebhookView) => deriveWebhookStatus(w) === filter.value;
        result = filter.operator === 'is'
          ? result.filter(matches)
          : result.filter((w) => !matches(w));
      }
    });
    return result;
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    try {
      await deleteWebhookMutation.mutateAsync(pendingDelete.id);
      toast.success(t.weldconnect.webhooks.toasts.deleted);
    } catch {
      toast.error(t.weldconnect.webhooks.toasts.deleteFailed);
    } finally {
      setPendingDelete(null);
    }
  }, [deleteWebhookMutation, pendingDelete, t.weldconnect.webhooks.toasts.deleted, t.weldconnect.webhooks.toasts.deleteFailed]);

  const renderRow = useCallback((webhook: WebhookView) => (
    <ConnectListRow
      key={webhook.id}
      label={webhookDisplayName(webhook)}
      onOpen={() => router.push(`/weldconnect/webhooks/${webhook.id}`)}
      menu={
        <ConnectRowMenu label={t.weldconnect.variables.actionsLabel}>
          <DropdownMenuItem onClick={() => router.push(`/weldconnect/webhooks/${webhook.id}`)}>
            <ExternalLink className="mr-2 h-4 w-4" />
            {t.weldconnect.webhooks.actions.viewDetails}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push(`/weldconnect/workflows/${webhook.workflowId}/edit`)}>
            <WorkflowIcon className="mr-2 h-4 w-4" />
            {t.weldconnect.webhookDetail.openInEditor}
          </DropdownMenuItem>
          {!webhook.isManaged && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className={DESTRUCTIVE_MENU_ITEM}
                onClick={() => setPendingDelete(webhook)}
                disabled={isPending}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {t.weldconnect.webhooks.actions.delete}
              </DropdownMenuItem>
            </>
          )}
        </ConnectRowMenu>
      }
    >
      <ConnectRowCell width="min-w-[200px] flex-1">
        <span title={webhook.externalUrl} className="flex min-w-0 items-center gap-2">
          <RowTitle chips={!webhook.isManaged ? <RowChip tone="gray">{wc.notLinked}</RowChip> : undefined}>
            {webhookDisplayName(webhook)}
          </RowTitle>
        </span>
      </ConnectRowCell>

      <ConnectRowCell width="w-[110px]">
        <WebhookStatusBadge status={deriveWebhookStatus(webhook)} />
      </ConnectRowCell>

      <ConnectRowCell width="w-[180px]">
        <RowText>{webhook.workflowName}</RowText>
      </ConnectRowCell>

      <ConnectRowCell width="w-[100px]">
        <RowText className="font-mono tabular-nums">{webhook.totalCalls ?? 0}</RowText>
      </ConnectRowCell>

      <ConnectRowCell width="w-[120px]">
        <span
          title={webhook.lastCalledAt
            ? wc.lastCalled.replace('{date}', new Date(webhook.lastCalledAt).toLocaleDateString())
            : undefined}
        >
          <RowDate>{new Date(webhook.createdAt).toLocaleDateString()}</RowDate>
        </span>
      </ConnectRowCell>
    </ConnectListRow>
  ), [isPending, router, t, wc.lastCalled, wc.notLinked]);

  return (
    <>
    <EntityList<WebhookView>
      items={webhooks}
      isLoading={isLoading}
      headerColumns={headerColumns}
      filters={filterConfigs}
      applyFilters={applyFilters}
      renderRow={renderRow}
      searchPlaceholder={t.weldconnect.webhooks.searchPlaceholder}
      searchFields={['name', 'workflowName']}
      emptyState={{
        icon: (
          <EmptyStateIllustration>
            <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="60" cy="44" r="16" className="stroke-gray-200 dark:stroke-border" strokeWidth="1" fill="none" />
              <path d="M60 60v24M48 72h24" className="stroke-gray-200 dark:stroke-border" strokeWidth="1.5" strokeLinecap="round" />
              <rect x="32" y="88" width="56" height="8" rx="4" className="fill-gray-200 dark:fill-border" opacity="0.5" />
            </svg>
          </EmptyStateIllustration>
        ),
        title: t.weldconnect.webhooks.noWebhooks,
        description: t.weldconnect.webhooks.noWebhooksDescription,
        action: {
          label: wc.goToWorkflows,
          onClick: () => router.push('/weldconnect/workflows'),
        },
      }}
      noResultsState={{
        title: wc.noResultsTitle,
        description: wc.noResultsDescription,
      }}
    />

    <ConfirmDialog
      open={!!pendingDelete}
      onOpenChange={(open) => !open && setPendingDelete(null)}
      title={t.weldconnect.webhooks.confirms.deleteTitle}
      description={t.weldconnect.webhooks.confirms.delete}
      confirmLabel={t.weldconnect.webhooks.actions.delete}
      cancelLabel={t.common.actions.cancel}
      variant="destructive"
      onConfirm={handleConfirmDelete}
    />
    </>
  );
}
