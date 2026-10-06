
import { useMemo, useCallback } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useRouter } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Trash2,
  CheckCircle,
  XCircle,
  EllipsisVertical,
  ExternalLink,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { useDeleteWebhook } from '@/hooks/queries/use-automation-queries';
import {
  EntityList,
  EmptyStateIllustration,
  type HeaderColumn,
  type FilterConfig,
  type ActiveFilter,
} from '@/components/entity-list';

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

  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'name', header: wc.columnName, width: 'min-w-[200px] flex-1' },
    { id: 'status', header: wc.columnStatus, width: 'w-[110px]' },
    { id: 'workflow', header: wc.columnWorkflow, width: 'w-[180px]' },
    { id: 'calls', header: wc.columnCalls, width: 'w-[100px]' },
    { id: 'created', header: wc.columnCreated, width: 'w-[120px]' },
    { id: 'actions', header: '', width: 'w-[48px] flex-shrink-0' },
  ], [wc]);

  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'status',
      label: wc.columnStatus,
      options: [
        { value: 'active', label: t.weldconnect.webhooks.statuses.active },
        { value: 'disabled', label: t.weldconnect.webhooks.statuses.disabled },
      ],
      getDisplayValue: (value) =>
        value === 'active'
          ? t.weldconnect.webhooks.statuses.active
          : t.weldconnect.webhooks.statuses.disabled,
    },
  ], [t, wc.columnStatus]);

  const applyFilters = useCallback((items: WebhookView[], filters: ActiveFilter[]) => {
    let result = items;
    filters.forEach((filter) => {
      if (!filter.operator || !filter.value) return;
      if (filter.field === 'status') {
        const matches = (w: WebhookView) =>
          filter.value === 'active' ? w.isEnabled : !w.isEnabled;
        result = filter.operator === 'is'
          ? result.filter(matches)
          : result.filter((w) => !matches(w));
      }
    });
    return result;
  }, []);

  const handleDeleteWebhook = useCallback((webhookId: string) => {
    if (!confirm(t.weldconnect.webhooks.confirms.delete)) return;

    deleteWebhookMutation.mutate(webhookId, {
      onSuccess: () => {
        toast.success(t.weldconnect.webhooks.toasts.deleted);
      },
      onError: () => {
        toast.error(t.weldconnect.webhooks.toasts.deleteFailed);
      },
    });
  }, [deleteWebhookMutation, t.weldconnect.webhooks.confirms.delete, t.weldconnect.webhooks.toasts.deleted, t.weldconnect.webhooks.toasts.deleteFailed]);

  const renderRow = useCallback((webhook: WebhookView) => (
    <div
      key={webhook.id}
      className="relative flex items-center gap-4 py-3 px-4 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer group border-b border-gray-200/70 dark:border-border"
    >
      <button
        type="button"
        onClick={() => router.push(`/weldconnect/webhooks/${webhook.id}`)}
        className="min-w-[200px] flex-1 min-w-0 text-left after:absolute after:inset-0 after:content-['']"
      >
        <span className="flex items-center gap-2 text-sm font-medium truncate">
          <span className="truncate">{webhook.name}</span>
          {!webhook.isManaged && (
            <Badge variant="outline" className="text-[10px] font-normal shrink-0">
              {wc.notLinked}
            </Badge>
          )}
        </span>
        <span className="block text-xs text-muted-foreground font-mono truncate">{webhook.externalUrl}</span>
      </button>

      <div className="w-[110px]">
        {webhook.isEnabled ? (
          <Badge variant="default" className="bg-green-500 text-[11px]">
            <CheckCircle className="h-3 w-3 mr-1" />
            {t.weldconnect.webhooks.statuses.active}
          </Badge>
        ) : (
          <Badge variant="secondary" className="text-[11px]">
            <XCircle className="h-3 w-3 mr-1" />
            {t.weldconnect.webhooks.statuses.disabled}
          </Badge>
        )}
      </div>

      <div className="w-[180px]">
        <span className="text-sm text-muted-foreground truncate block">
          {webhook.workflowName || '—'}
        </span>
      </div>

      <div className="w-[100px]">
        <span className="text-sm font-mono tabular-nums">{webhook.totalCalls ?? 0}</span>
      </div>

      <div className="w-[120px]">
        <div className="text-sm">{new Date(webhook.createdAt).toLocaleDateString()}</div>
        {webhook.lastCalledAt && (
          <div className="text-xs text-muted-foreground">
            {wc.lastCalled.replace('{date}', new Date(webhook.lastCalledAt).toLocaleDateString())}
          </div>
        )}
      </div>

      <div className="relative z-10 w-[48px] flex-shrink-0 flex justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <EllipsisVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{t.weldconnect.variables.actionsLabel}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => router.push(`/weldconnect/webhooks/${webhook.id}`)}>
              <ExternalLink className="mr-0.5 h-4 w-4" />
              {t.weldconnect.webhooks.actions.viewDetails}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => router.push(`/weldconnect/workflows/${webhook.workflowId}/edit`)}>
              <WorkflowIcon className="mr-0.5 h-4 w-4" />
              {t.weldconnect.webhookDetail.openInEditor}
            </DropdownMenuItem>
            {!webhook.isManaged && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => handleDeleteWebhook(webhook.id)}
                  disabled={isPending}
                >
                  <Trash2 className="mr-0.5 h-4 w-4 text-red-600 dark:text-red-400" />
                  {t.weldconnect.webhooks.actions.delete}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  ), [handleDeleteWebhook, isPending, router, t, wc.lastCalled, wc.notLinked]);

  return (
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
  );
}
